import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';

import { createStorage } from '../src/storage/index.js';
import { createCtx, type Ctx, type TestUser } from './helpers.js';

let t: Ctx;
let admin: TestUser;
let ayesha: TestUser;
let bilal: TestUser;
let sara: TestUser;
let outsider: TestUser;

beforeAll(async () => {
  t = await createCtx();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  await t.universe('iac');
  await t.universe('uol');
  admin = await t.user({ email: 'admin@iac.test', name: 'Admin', uni: 'iac', role: 'uni_admin' });
  ayesha = await t.user({ email: 'ayesha@iac.test', name: 'Ayesha Khan', uni: 'iac', department: 'Computer Science' });
  bilal = await t.user({ email: 'bilal@iac.test', name: 'Bilal Ahmed', uni: 'iac', department: 'Business' });
  sara = await t.user({ email: 'sara@iac.test', name: 'Sara Malik', uni: 'iac' });
  outsider = await t.user({ email: 'omar@uol.test', name: 'Omar', uni: 'uol' });
});

const storage = () => createStorage(t.config.uploadsDir);
const pdf = (text = 'hello') => Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n% ${text}\ntrailer\n<< >>\n%%EOF`);
const jpeg = () => sharp({ create: { width: 500, height: 400, channels: 3, background: '#aa6633' } }).jpeg().toBuffer();
const fetchFile = (path: string) => t.app.inject({ method: 'GET', url: path });

// ── notes ────────────────────────────────────────────────────────────────────
const note = async (by: TestUser = ayesha, over: Record<string, string> = {}, files?: { name: string; data: Buffer }[]) => {
  const r = await t.upload('/v1/notes', by.token, files ?? [{ name: 'lecture1.pdf', data: pdf() }], { title: 'Data Structures: Week 1', course: 'CS201', kind: 'notes', description: 'Trees and graphs', ...over });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};

describe('notes and past papers', () => {
  it('shares a PDF and a picture of notes; each opens with a signed link', async () => {
    const n = await note(ayesha, {}, [{ name: 'lecture1.pdf', data: pdf('page one') }, { name: 'board.jpg', data: await jpeg() }]);
    expect(n).toMatchObject({ title: 'Data Structures: Week 1', course: 'CS201', department: 'Computer Science', fileCount: 2, mine: true });
    const detail = (await t.call('GET', `/v1/notes/${n.id}`, { token: bilal.token })).body;
    expect(detail.files.map((f: any) => f.mime)).toEqual(['application/pdf', 'image/jpeg']);
    const doc = await fetchFile(detail.files[0].url);
    expect(doc.statusCode).toBe(200);
    expect(doc.headers['content-type']).toBe('application/pdf');
    expect(doc.headers['content-disposition']).toContain('attachment'); // a PDF is downloaded, never run in a page
    expect(doc.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await fetchFile(detail.files[1].url)).headers['content-type']).toBe('image/jpeg');
  });

  it('refuses files that are neither a PDF nor a picture, however they are named', async () => {
    for (const data of [Buffer.from('<?php system($_GET["x"]); ?>'), Buffer.from('MZ\x90\x00 pretend exe'), Buffer.from('plain text')]) {
      const r = await t.upload('/v1/notes', ayesha.token, [{ name: 'notes.pdf', data, type: 'application/pdf' }], { title: 'Sneaky upload', course: 'CS201' });
      expect(r.status).toBe(400);
    }
    expect((await t.pool.query('SELECT count(*)::int AS n FROM study_notes')).rows[0].n).toBe(0);
  });

  it('is all-or-nothing and needs a title, a course and a file', async () => {
    const bad = await t.upload('/v1/notes', ayesha.token, [{ name: 'a.pdf', data: pdf() }, { name: 'b.pdf', data: Buffer.from('nope') }], { title: 'Two files', course: 'CS201' });
    expect(bad.status).toBe(400);
    expect((await t.pool.query('SELECT count(*)::int AS n FROM study_notes')).rows[0].n).toBe(0);
    expect((await t.upload('/v1/notes', ayesha.token, [], { title: 'No file', course: 'CS201' })).status).toBe(400);
    expect((await t.upload('/v1/notes', ayesha.token, [{ name: 'a.pdf', data: pdf() }], { title: 'ab', course: 'CS201' })).status).toBe(400);
    expect((await t.upload('/v1/notes', ayesha.token, [{ name: 'a.pdf', data: pdf() }], { title: 'Fine title' })).status).toBe(400);
  });

  it('searches and filters by course, kind and text; lists the courses', async () => {
    await note(ayesha, { title: 'Algorithms notes', course: 'CS301', kind: 'notes' });
    await note(bilal, { title: 'Marketing mid-term 2024', course: 'MKT101', kind: 'past_paper' });
    const list = async (qs: string) => (await t.call('GET', `/v1/notes${qs}`, { token: sara.token })).body;
    expect((await list('')).notes).toHaveLength(2);
    expect((await list('?kind=past_paper')).notes.map((n: any) => n.title)).toEqual(['Marketing mid-term 2024']);
    expect((await list('?course=cs301')).notes).toHaveLength(1);
    expect((await list('?q=algo')).notes).toHaveLength(1);
    expect((await list('?q=%25')).notes).toHaveLength(0); // a % is text, not a wildcard
    expect((await list('')).courses).toEqual(['CS301', 'MKT101']);
  });

  it('"helpful" counts once per person', async () => {
    const n = await note();
    await t.call('PUT', `/v1/notes/${n.id}/helpful`, { token: bilal.token });
    await t.call('PUT', `/v1/notes/${n.id}/helpful`, { token: bilal.token });
    expect((await t.call('PUT', `/v1/notes/${n.id}/helpful`, { token: sara.token })).body.helpfulCount).toBe(2);
    expect((await t.call('DELETE', `/v1/notes/${n.id}/helpful`, { token: sara.token })).body.helpfulCount).toBe(1);
  });

  it('only the uploader or an admin deletes; the files go too', async () => {
    const n = await note();
    const key = (await t.pool.query('SELECT storage_key FROM note_files WHERE note_id = $1', [n.id])).rows[0].storage_key;
    expect((await t.call('DELETE', `/v1/notes/${n.id}`, { token: bilal.token })).status).toBe(403);
    expect((await t.call('DELETE', `/v1/notes/${n.id}`, { token: ayesha.token })).status).toBe(204);
    expect(await storage().open(key)).toBeNull();
  });

  it('another university sees nothing and cannot use the links', async () => {
    const n = await note();
    const detail = (await t.call('GET', `/v1/notes/${n.id}`, { token: ayesha.token })).body;
    expect((await t.call('GET', '/v1/notes', { token: outsider.token })).body.notes).toEqual([]);
    expect((await t.call('GET', `/v1/notes/${n.id}`, { token: outsider.token })).status).toBe(404);
    expect((await t.call('PUT', `/v1/notes/${n.id}/helpful`, { token: outsider.token })).status).toBe(404);
    expect((await t.call('DELETE', `/v1/notes/${n.id}`, { token: outsider.token })).status).toBe(404);
    const u = new URL(detail.files[0].url, 'http://x');
    u.searchParams.set('sig', 'x'.repeat(27));
    expect((await fetchFile(u.pathname + u.search)).statusCode).toBe(404);
  });

  it('a hidden note disappears for everyone but its owner and admins, and its files stop opening', async () => {
    const n = await note();
    const url = (await t.call('GET', `/v1/notes/${n.id}`, { token: ayesha.token })).body.files[0].url;
    await t.pool.query(`UPDATE study_notes SET status = 'hidden' WHERE id = $1`, [n.id]);
    expect((await t.call('GET', '/v1/notes', { token: bilal.token })).body.notes).toEqual([]);
    expect((await t.call('GET', `/v1/notes/${n.id}`, { token: bilal.token })).status).toBe(404);
    expect((await fetchFile(url)).statusCode).toBe(404);
    expect((await t.call('GET', `/v1/notes/${n.id}`, { token: ayesha.token })).status).toBe(200);
    expect((await t.call('GET', '/v1/notes?include=hidden', { token: admin.token })).body.notes).toHaveLength(1);
  });

  it('leaving the university removes what you shared, files included', async () => {
    const n = await note();
    const key = (await t.pool.query('SELECT storage_key FROM note_files WHERE note_id = $1', [n.id])).rows[0].storage_key;
    await t.call('DELETE', '/v1/membership', { token: ayesha.token });
    expect((await t.pool.query('SELECT count(*)::int AS n FROM study_notes')).rows[0].n).toBe(0);
    expect(await storage().open(key)).toBeNull();
  });
});

// ── book market ──────────────────────────────────────────────────────────────
const photos = async (by: TestUser, n = 1) => {
  const r = await t.upload('/v1/media', by.token, await Promise.all(Array.from({ length: n }, async (_, i) => ({ name: `b${i}.jpg`, data: await jpeg() }))));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.media as any[];
};
const book = async (by: TestUser = ayesha, over: Record<string, unknown> = {}) => {
  const r = await t.call('POST', '/v1/books', { token: by.token, body: { title: 'Introduction to Algorithms', author: 'Cormen', course: 'CS301', price: 1500, condition: 'good', ...over } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};

describe('book market', () => {
  it('lists a book with photos, and shows price, condition and the seller', async () => {
    const m = await photos(ayesha, 2);
    const b = await book(ayesha, { mediaIds: m.map(x => x.id) });
    expect(b).toMatchObject({ title: 'Introduction to Algorithms', price: 1500, condition: 'good', sellerName: 'Ayesha Khan', mine: true, status: 'available' });
    expect(b.photos).toHaveLength(2);
    expect((await fetchFile(b.photos[0].thumbUrl)).statusCode).toBe(200);
    expect((await t.call('GET', '/v1/books', { token: bilal.token })).body.books).toHaveLength(1);
  });

  it('only accepts your own, unused photos (at most 3) and real pictures', async () => {
    const mine = await photos(ayesha, 1);
    const theirs = await photos(bilal, 1);
    expect((await t.call('POST', '/v1/books', { token: ayesha.token, body: { title: 'Stolen photo', price: 10, condition: 'good', mediaIds: [theirs[0].id] } })).status).toBe(400);
    await book(ayesha, { mediaIds: [mine[0].id] });
    expect((await t.call('POST', '/v1/books', { token: ayesha.token, body: { title: 'Reused photo', price: 10, condition: 'good', mediaIds: [mine[0].id] } })).status).toBe(400);
    const four = ['a', 'b', 'c', 'd'].map(() => '11111111-1111-4111-8111-111111111111');
    expect((await t.call('POST', '/v1/books', { token: ayesha.token, body: { title: 'Too many photos', price: 10, condition: 'good', mediaIds: four } })).status).toBe(400);
    expect((await t.upload('/v1/media', ayesha.token, [{ name: 'x.jpg', data: Buffer.from('<html>not a picture</html>') }])).status).toBe(400);
  });

  it('validates price, condition and title', async () => {
    const bad = async (over: Record<string, unknown>) => (await t.call('POST', '/v1/books', { token: ayesha.token, body: { title: 'Valid title', price: 10, condition: 'good', ...over } })).status;
    expect(await bad({ price: -1 })).toBe(400);
    expect(await bad({ price: 1.5 })).toBe(400);
    expect(await bad({ condition: 'broken' })).toBe(400);
    expect(await bad({ title: 'x' })).toBe(400);
  });

  it('interest tells the seller once; only the seller sees the count and who asked', async () => {
    const b = await book();
    t.push.reset();
    expect((await t.call('POST', `/v1/books/${b.id}/interest`, { token: ayesha.token })).status).toBe(403);
    await t.call('POST', `/v1/books/${b.id}/interest`, { token: bilal.token });
    await t.call('POST', `/v1/books/${b.id}/interest`, { token: bilal.token });
    expect(t.push.sent.filter(m => m.userIds.includes(ayesha.id))).toHaveLength(1);
    expect((await t.call('GET', `/v1/books/${b.id}`, { token: ayesha.token })).body.interestedCount).toBe(1);
    const theirs = (await t.call('GET', `/v1/books/${b.id}`, { token: bilal.token })).body;
    expect(theirs).toMatchObject({ interestedCount: null, iAsked: true });
    expect((await t.call('GET', `/v1/books/${b.id}/interested`, { token: ayesha.token })).body.interested.map((x: any) => x.name)).toEqual(['Bilal Ahmed']);
    expect((await t.call('GET', `/v1/books/${b.id}/interested`, { token: bilal.token })).status).toBe(403);
  });

  it('the seller marks it sold; a sold book leaves the market but stays under "mine"; nobody can ask for it', async () => {
    const b = await book();
    expect((await t.call('PATCH', `/v1/books/${b.id}`, { token: bilal.token, body: { status: 'sold' } })).status).toBe(403);
    expect((await t.call('PATCH', `/v1/books/${b.id}`, { token: ayesha.token, body: { status: 'sold', price: 1200 } })).body).toMatchObject({ status: 'sold', price: 1200 });
    expect((await t.call('GET', '/v1/books', { token: bilal.token })).body.books).toEqual([]);
    expect((await t.call('GET', '/v1/books?scope=mine', { token: ayesha.token })).body.books).toHaveLength(1);
    expect((await t.call('POST', `/v1/books/${b.id}/interest`, { token: bilal.token })).status).toBe(409);
  });

  it('removing a listing deletes its photos and files; an admin can remove anyone’s', async () => {
    const m = await photos(ayesha, 1);
    const b = await book(ayesha, { mediaIds: [m[0].id] });
    const keys = (await t.pool.query('SELECT storage_key FROM media WHERE id = $1', [m[0].id])).rows[0].storage_key;
    expect((await t.call('DELETE', `/v1/books/${b.id}`, { token: bilal.token })).status).toBe(403);
    expect((await t.call('DELETE', `/v1/books/${b.id}`, { token: admin.token })).status).toBe(204);
    expect(await storage().open(keys)).toBeNull();
    expect((await t.pool.query('SELECT count(*)::int AS n FROM media')).rows[0].n).toBe(0);
  });

  it('another university cannot see, ask about or change a book', async () => {
    const b = await book();
    expect((await t.call('GET', '/v1/books', { token: outsider.token })).body.books).toEqual([]);
    for (const [method, url] of [['GET', `/v1/books/${b.id}`], ['POST', `/v1/books/${b.id}/interest`], ['PATCH', `/v1/books/${b.id}`], ['DELETE', `/v1/books/${b.id}`]] as const) {
      expect((await t.call(method, url, { token: outsider.token, body: {} })).status, `${method} ${url}`).toBe(404);
    }
  });

  it('the database refuses a photo that belongs to another university', async () => {
    const m = await photos(ayesha, 1);
    const b = await book();
    await expect(t.pool.query(`INSERT INTO book_photos (book_id, media_id, university_id) VALUES ($1, $2, 'uol')`, [b.id, m[0].id])).rejects.toThrow();
  });
});

// ── study groups ─────────────────────────────────────────────────────────────
const group = async (by: TestUser = ayesha, over: Record<string, unknown> = {}) => {
  const r = await t.call('POST', '/v1/study-groups', { token: by.token, body: { title: 'CS201 exam prep', course: 'CS201', meeting: 'Library, Thursdays 4 PM', capacity: 3, ...over } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};

describe('study groups', () => {
  it('the creator is the first member; others join and leave', async () => {
    const g = await group();
    expect(g).toMatchObject({ memberCount: 1, joined: true, mine: true, full: false });
    t.push.reset();
    expect((await t.call('PUT', `/v1/study-groups/${g.id}/join`, { token: bilal.token })).body).toMatchObject({ memberCount: 2, joined: true });
    expect(t.push.sent.filter(m => m.userIds.includes(ayesha.id))).toHaveLength(1);
    await t.call('PUT', `/v1/study-groups/${g.id}/join`, { token: bilal.token }); // again: still one seat
    expect((await t.call('GET', `/v1/study-groups/${g.id}`, { token: sara.token })).body.members.map((m: any) => m.name)).toEqual(['Ayesha Khan', 'Bilal Ahmed']);
    expect((await t.call('DELETE', `/v1/study-groups/${g.id}/join`, { token: bilal.token })).body.memberCount).toBe(1);
    expect((await t.call('DELETE', `/v1/study-groups/${g.id}/join`, { token: ayesha.token })).status).toBe(409); // the creator closes it instead
  });

  it('the last seat goes to one person even when several join at once', async () => {
    const g = await group(ayesha, { capacity: 3 });
    const extra = await Promise.all(Array.from({ length: 6 }, (_, i) => t.user({ email: `s${i}@iac.test`, uni: 'iac' })));
    const results = await Promise.all(extra.map(u => t.call('PUT', `/v1/study-groups/${g.id}/join`, { token: u.token })));
    expect(results.filter(r => r.status === 200)).toHaveLength(2); // 1 creator + 2 = 3 seats
    expect(results.filter(r => r.status === 409).every(r => r.body.error.code === 'group_full')).toBe(true);
    expect((await t.call('GET', `/v1/study-groups/${g.id}`, { token: ayesha.token })).body.memberCount).toBe(3);
  });

  it('a closed group takes no one; only the creator or an admin changes or deletes it', async () => {
    const g = await group();
    expect((await t.call('PATCH', `/v1/study-groups/${g.id}`, { token: bilal.token, body: { status: 'closed' } })).status).toBe(403);
    expect((await t.call('PATCH', `/v1/study-groups/${g.id}`, { token: ayesha.token, body: { status: 'closed' } })).body.status).toBe('closed');
    expect((await t.call('PUT', `/v1/study-groups/${g.id}/join`, { token: bilal.token })).body.error.code).toBe('group_closed');
    expect((await t.call('GET', '/v1/study-groups', { token: bilal.token })).body.groups).toEqual([]);
    expect((await t.call('DELETE', `/v1/study-groups/${g.id}`, { token: bilal.token })).status).toBe(403);
    expect((await t.call('DELETE', `/v1/study-groups/${g.id}`, { token: admin.token })).status).toBe(204);
  });

  it('"mine" lists groups I started or joined; search works; validation applies', async () => {
    const g = await group(ayesha, { title: 'Physics revision', course: 'PHY101' });
    await group(bilal, { title: 'Marketing case study', course: 'MKT101' });
    await t.call('PUT', `/v1/study-groups/${g.id}/join`, { token: sara.token });
    expect((await t.call('GET', '/v1/study-groups?scope=mine', { token: sara.token })).body.groups.map((x: any) => x.title)).toEqual(['Physics revision']);
    expect((await t.call('GET', '/v1/study-groups?q=market', { token: sara.token })).body.groups).toHaveLength(1);
    expect((await t.call('POST', '/v1/study-groups', { token: ayesha.token, body: { title: 'ab' } })).status).toBe(400);
    expect((await t.call('POST', '/v1/study-groups', { token: ayesha.token, body: { title: 'Valid title', capacity: 1 } })).status).toBe(400);
  });

  it('another university cannot see or join a group', async () => {
    const g = await group();
    expect((await t.call('GET', '/v1/study-groups', { token: outsider.token })).body.groups).toEqual([]);
    expect((await t.call('PUT', `/v1/study-groups/${g.id}/join`, { token: outsider.token })).status).toBe(404);
    await expect(t.pool.query(`INSERT INTO study_group_members (group_id, university_id, user_id) VALUES ($1, 'uol', $2)`, [g.id, outsider.id])).rejects.toThrow();
  });
});

// ── jobs ─────────────────────────────────────────────────────────────────────
const job = async (over: Record<string, unknown> = {}) => {
  const r = await t.call('POST', '/v1/jobs', { token: admin.token, body: { company: 'Acme Software', title: 'Junior Developer', kind: 'job', location: 'Lahore', description: 'Build things.', applyUrl: 'https://acme.example/jobs/1', ...over } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};

describe('jobs and internships', () => {
  it('only admins post; students see open ones, filter and search', async () => {
    expect((await t.call('POST', '/v1/jobs', { token: ayesha.token, body: { company: 'Acme', title: 'Dev', kind: 'job', applyUrl: 'https://a.example' } })).status).toBe(403);
    await job();
    await job({ title: 'Design Intern', kind: 'internship', company: 'Studio Nine', applyUrl: null, applyEmail: 'Hr@Studio.example' });
    const all = (await t.call('GET', '/v1/jobs', { token: ayesha.token })).body.jobs;
    expect(all).toHaveLength(2);
    expect(all.find((j: any) => j.kind === 'internship').applyEmail).toBe('hr@studio.example');
    expect((await t.call('GET', '/v1/jobs?kind=internship', { token: ayesha.token })).body.jobs).toHaveLength(1);
    expect((await t.call('GET', '/v1/jobs?q=studio', { token: ayesha.token })).body.jobs).toHaveLength(1);
  });

  it('needs a way to apply, and only https links', async () => {
    const bad = async (over: Record<string, unknown>) => (await t.call('POST', '/v1/jobs', { token: admin.token, body: { company: 'Acme', title: 'Developer', kind: 'job', ...over } })).status;
    expect(await bad({})).toBe(400); // no link and no email
    expect(await bad({ applyUrl: 'http://insecure.example' })).toBe(400);
    expect(await bad({ applyUrl: 'javascript:alert(1)' })).toBe(400);
    expect(await bad({ applyEmail: 'not-an-email' })).toBe(400);
    expect(await bad({ applyUrl: 'https://ok.example', kind: 'volunteer' })).toBe(400);
  });

  it('closed and past-deadline openings leave the list; admins can still see them', async () => {
    const open = await job({ title: 'Open one' });
    const closed = await job({ title: 'Closed one' });
    await job({ title: 'Too late', deadline: Date.now() - 86_400_000 });
    await t.call('PATCH', `/v1/jobs/${closed.id}`, { token: admin.token, body: { status: 'closed' } });
    expect((await t.call('GET', '/v1/jobs', { token: ayesha.token })).body.jobs.map((j: any) => j.title)).toEqual(['Open one']);
    expect((await t.call('GET', '/v1/jobs?include=closed', { token: admin.token })).body.jobs).toHaveLength(3);
    expect((await t.call('GET', '/v1/jobs?include=closed', { token: ayesha.token })).body.jobs).toHaveLength(1); // students cannot ask for closed ones
    expect(open.expired).toBe(false);
  });

  it('students save and unsave openings', async () => {
    const j = await job();
    await t.call('PUT', `/v1/jobs/${j.id}/save`, { token: ayesha.token });
    expect((await t.call('GET', '/v1/jobs?scope=saved', { token: ayesha.token })).body.jobs).toHaveLength(1);
    expect((await t.call('GET', '/v1/jobs?scope=saved', { token: bilal.token })).body.jobs).toEqual([]);
    await t.call('DELETE', `/v1/jobs/${j.id}/save`, { token: ayesha.token });
    expect((await t.call('GET', '/v1/jobs?scope=saved', { token: ayesha.token })).body.jobs).toEqual([]);
  });

  it('another university has its own openings', async () => {
    const j = await job();
    expect((await t.call('GET', '/v1/jobs', { token: outsider.token })).body.jobs).toEqual([]);
    expect((await t.call('GET', `/v1/jobs/${j.id}`, { token: outsider.token })).status).toBe(404);
    expect((await t.call('PUT', `/v1/jobs/${j.id}/save`, { token: outsider.token })).status).toBe(404);
    const uolAdmin = await t.user({ email: 'admin@uol.test', uni: 'uol', role: 'uni_admin' });
    expect((await t.call('DELETE', `/v1/jobs/${j.id}`, { token: uolAdmin.token })).status).toBe(404);
  });
});

// ── CV ───────────────────────────────────────────────────────────────────────
describe('CV builder', () => {
  it('combines what the student typed with what the university’s records show', async () => {
    const ev = (await t.call('POST', '/v1/events', { token: admin.token, body: { title: 'Hackathon', organizer: 'Office', category: 'Tech', blurb: 'A long hackathon event.', venue: 'Lab', startsAt: Date.now() - 600_000, endsAt: Date.now() + 3_600_000 } })).body.id;
    const ticket = (await t.call('PUT', `/v1/events/${ev}/rsvp`, { token: ayesha.token, body: { status: 'going' } })).body;
    const sec = await t.user({ email: 'sec@iac.test', uni: 'iac', role: 'security' });
    await t.call('POST', '/v1/checkin', { token: sec.token, body: { payload: `CH1|T|iac|${ev}|${ayesha.id}|${ticket.code}` } });
    const s = (await t.call('POST', '/v1/societies', { token: admin.token, body: { name: 'Coding Club', category: 'Tech' } })).body;
    await t.call('PUT', `/v1/societies/${s.id}/join`, { token: ayesha.token });

    const saved = await t.call('PUT', '/v1/cv/profile', { token: ayesha.token, body: { summary: 'Final-year CS student.', skills: ['TypeScript', 'SQL', 'typescript '.trim()], links: ['https://github.com/ayesha'] } });
    expect(saved.body.skills).toEqual(['TypeScript', 'SQL', 'typescript']);
    const cv = (await t.call('GET', '/v1/cv', { token: ayesha.token })).body;
    expect(cv).toMatchObject({ name: 'Ayesha Khan', department: 'Computer Science', summary: 'Final-year CS student.', university: 'IAC Campus' });
    expect(cv.eventsAttended.map((e: any) => e.title)).toEqual(['Hackathon']);
    expect(cv.societies).toEqual([{ name: 'Coding Club', role: 'member' }]);
    expect(cv.badges).toBeUndefined();
  });

  it('shows nothing it cannot verify: you cannot type your own achievements', async () => {
    await t.call('PUT', '/v1/cv/profile', { token: ayesha.token, body: { summary: 'x', skills: [], links: [], eventsAttended: [{ title: 'Fake' }] } });
    const cv = (await t.call('GET', '/v1/cv', { token: ayesha.token })).body;
    expect(cv.eventsAttended).toEqual([]);
  });

  it('validates the profile and keeps it private to the person', async () => {
    const put = (body: Record<string, unknown>) => t.call('PUT', '/v1/cv/profile', { token: ayesha.token, body });
    expect((await put({ summary: 'x'.repeat(601) })).status).toBe(400);
    expect((await put({ skills: Array.from({ length: 16 }, (_, i) => `s${i}`) })).status).toBe(400);
    expect((await put({ links: ['http://insecure.example'] })).status).toBe(400);
    expect((await put({ links: ['a', 'b', 'c', 'd'].map(x => `https://${x}.example`) })).status).toBe(400);
    await put({ summary: 'Private summary', skills: [], links: [] });
    expect((await t.call('GET', '/v1/cv', { token: bilal.token })).body.summary).toBe('');
  });
});

// ── reports ──────────────────────────────────────────────────────────────────
describe('reports and moderation', () => {
  it('anyone reports content of their own university, once; not their own post', async () => {
    const n = await note(ayesha);
    const report = (u: TestUser, over: Record<string, unknown> = {}) => t.call('POST', '/v1/reports', { token: u.token, body: { targetType: 'note', targetId: n.id, reason: 'spam', ...over } });
    expect((await report(ayesha)).status).toBe(400);
    expect((await report(bilal)).status).toBe(201);
    expect((await report(bilal)).status).toBe(201); // again: still one report
    expect((await t.pool.query('SELECT count(*)::int AS n FROM content_reports')).rows[0].n).toBe(1);
    expect((await report(outsider)).status).toBe(404);
    expect((await report(bilal, { reason: 'rude' })).status).toBe(400);
    expect((await report(bilal, { targetId: '11111111-1111-4111-8111-111111111111' })).status).toBe(404);
  });

  it('admins see the open reports and remove or dismiss; removing hides the item for everyone', async () => {
    const n = await note(ayesha, { title: 'Reported note' });
    const b = await book(ayesha, { title: 'Reported book' });
    for (const [type, id] of [['note', n.id], ['book', b.id]]) {
      await t.call('POST', '/v1/reports', { token: bilal.token, body: { targetType: type, targetId: id, reason: 'scam' } });
      await t.call('POST', '/v1/reports', { token: sara.token, body: { targetType: type, targetId: id, reason: 'spam' } });
    }
    expect((await t.call('GET', '/v1/admin/reports', { token: bilal.token })).status).toBe(403);
    const open = (await t.call('GET', '/v1/admin/reports', { token: admin.token })).body.reports;
    expect(open).toHaveLength(4);
    expect(open[0]).toMatchObject({ totalReports: 2 });
    expect(open.map((r: any) => r.title).sort()).toEqual(['Reported book', 'Reported book', 'Reported note', 'Reported note']);

    const noteReport = open.find((r: any) => r.targetType === 'note');
    expect((await t.call('POST', `/v1/admin/reports/${noteReport.id}`, { token: admin.token, body: { action: 'remove' } })).status).toBe(200);
    expect((await t.call('GET', '/v1/notes', { token: bilal.token })).body.notes).toEqual([]);
    expect((await t.call('POST', `/v1/admin/reports/${noteReport.id}`, { token: admin.token, body: { action: 'dismiss' } })).status).toBe(409);

    const bookReport = open.find((r: any) => r.targetType === 'book');
    await t.call('POST', `/v1/admin/reports/${bookReport.id}`, { token: admin.token, body: { action: 'dismiss' } });
    expect((await t.call('GET', '/v1/books', { token: bilal.token })).body.books).toHaveLength(1);
    expect((await t.call('GET', '/v1/admin/reports', { token: admin.token })).body.reports).toEqual([]);
    expect((await t.call('GET', '/v1/admin/reports?status=actioned', { token: admin.token })).body.reports).toHaveLength(2);
  });

  it('reporting a person and removing suspends them (admins cannot suspend themselves)', async () => {
    await t.call('POST', '/v1/reports', { token: bilal.token, body: { targetType: 'user', targetId: sara.id, reason: 'harassment', details: 'Sent rude messages' } });
    const r = (await t.call('GET', '/v1/admin/reports', { token: admin.token })).body.reports[0];
    expect(r).toMatchObject({ targetType: 'user', title: 'Sara Malik', details: 'Sent rude messages' });
    await t.call('POST', `/v1/admin/reports/${r.id}`, { token: admin.token, body: { action: 'remove' } });
    expect((await t.call('GET', '/v1/me', { token: sara.token })).body.membership.status).toBe('suspended');
    expect((await t.call('GET', '/v1/notes', { token: sara.token })).status).toBe(403);
    await t.call('POST', '/v1/reports', { token: bilal.token, body: { targetType: 'user', targetId: admin.id, reason: 'other' } });
    const r2 = (await t.call('GET', '/v1/admin/reports', { token: admin.token })).body.reports[0];
    expect((await t.call('POST', `/v1/admin/reports/${r2.id}`, { token: admin.token, body: { action: 'remove' } })).status).toBe(403);
  });

  it('another university’s admin cannot see or act on these reports', async () => {
    const n = await note(ayesha);
    await t.call('POST', '/v1/reports', { token: bilal.token, body: { targetType: 'note', targetId: n.id, reason: 'spam' } });
    const uolAdmin = await t.user({ email: 'admin@uol.test', uni: 'uol', role: 'uni_admin' });
    expect((await t.call('GET', '/v1/admin/reports', { token: uolAdmin.token })).body.reports).toEqual([]);
    const id = (await t.pool.query('SELECT id FROM content_reports')).rows[0].id;
    expect((await t.call('POST', `/v1/admin/reports/${id}`, { token: uolAdmin.token, body: { action: 'remove' } })).status).toBe(404);
  });
});
