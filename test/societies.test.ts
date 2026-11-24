import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createCtx, eventBody, type Ctx, type TestUser } from './helpers.js';

let t: Ctx;
let admin: TestUser;
let head: TestUser;
let ayesha: TestUser;
let bilal: TestUser;
let outsider: TestUser; // a student of ANOTHER university

beforeAll(async () => {
  t = await createCtx();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  await t.universe('iac');
  await t.universe('uol');
  admin = await t.user({ email: 'admin@iac.test', name: 'Admin', uni: 'iac', role: 'uni_admin' });
  head = await t.user({ email: 'head@iac.test', name: 'Head', uni: 'iac', role: 'society_head' });
  ayesha = await t.user({ email: 'ayesha@iac.test', name: 'Ayesha', uni: 'iac' });
  bilal = await t.user({ email: 'bilal@iac.test', name: 'Bilal', uni: 'iac' });
  outsider = await t.user({ email: 'omar@uol.test', name: 'Omar', uni: 'uol' });
});

const make = async (name = 'Debating Society', by: TestUser = admin) => {
  const r = await t.call('POST', '/v1/societies', { token: by.token, body: { name, about: 'Public speaking', category: 'Career' } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};
const list = async (u: TestUser) => (await t.call('GET', '/v1/societies', { token: u.token })).body.societies as any[];

describe('creating and listing', () => {
  it('only admins create societies; names are unique inside a university', async () => {
    const body = { name: 'Chess Club', about: 'Moves', category: 'Social' };
    expect((await t.call('POST', '/v1/societies', { token: ayesha.token, body })).status).toBe(403);
    expect((await t.call('POST', '/v1/societies', { token: head.token, body })).status).toBe(403);
    expect((await t.call('POST', '/v1/societies', { token: admin.token, body })).status).toBe(201);
    const again = await t.call('POST', '/v1/societies', { token: admin.token, body: { ...body, name: 'chess club' } });
    expect(again.status).toBe(409);
    // The same name is fine in another university.
    const uolAdmin = await t.user({ email: 'admin@uol.test', uni: 'uol', role: 'uni_admin' });
    expect((await t.call('POST', '/v1/societies', { token: uolAdmin.token, body })).status).toBe(201);
  });

  it('validates the fields', async () => {
    const bad = async (over: Record<string, unknown>) => (await t.call('POST', '/v1/societies', { token: admin.token, body: { name: 'Valid Name', about: '', category: 'Tech', ...over } })).status;
    expect(await bad({ name: 'x' })).toBe(400);
    expect(await bad({ category: 'Astrology' })).toBe(400);
    expect(await bad({ about: 'x'.repeat(501) })).toBe(400);
  });

  it('lists members, my own place and the next event', async () => {
    const s = await make();
    await t.call('PUT', `/v1/societies/${s.id}/join`, { token: ayesha.token });
    await t.call('PUT', `/v1/societies/${s.id}/join`, { token: bilal.token });
    await t.call('PUT', `/v1/societies/${s.id}/heads/${head.id}`, { token: admin.token });
    await t.call('POST', '/v1/events', { token: admin.token, body: eventBody({ societyId: s.id, title: 'Open mic night' }) });

    const mine = (await list(ayesha)).find(x => x.id === s.id);
    expect(mine).toMatchObject({ memberCount: 3, joined: true, myRole: 'member' });
    expect(mine.nextEvent.title).toBe('Open mic night');
    const notJoined = (await list(admin)).find(x => x.id === s.id);
    expect(notJoined).toMatchObject({ joined: false, myRole: null });
  });
});

describe('joining', () => {
  it('joining twice counts once; leaving works; both are idempotent', async () => {
    const s = await make();
    await t.call('PUT', `/v1/societies/${s.id}/join`, { token: ayesha.token });
    const again = await t.call('PUT', `/v1/societies/${s.id}/join`, { token: ayesha.token });
    expect(again.body.memberCount).toBe(1);
    const left = await t.call('DELETE', `/v1/societies/${s.id}/join`, { token: ayesha.token });
    expect(left.body).toMatchObject({ memberCount: 0, joined: false });
    expect((await t.call('DELETE', `/v1/societies/${s.id}/join`, { token: ayesha.token })).status).toBe(200);
  });

  it('shows the member list with heads first', async () => {
    const s = await make();
    await t.call('PUT', `/v1/societies/${s.id}/join`, { token: ayesha.token });
    await t.call('PUT', `/v1/societies/${s.id}/heads/${head.id}`, { token: admin.token });
    const r = await t.call('GET', `/v1/societies/${s.id}/members`, { token: bilal.token });
    expect(r.body.members.map((m: any) => m.role)).toEqual(['head', 'member']);
    expect(JSON.stringify(r.body)).not.toContain('@'); // no email addresses are exposed
  });

  it('leaving the university removes the society membership', async () => {
    const s = await make();
    await t.call('PUT', `/v1/societies/${s.id}/join`, { token: ayesha.token });
    await t.call('DELETE', '/v1/membership', { token: ayesha.token });
    const n = await t.pool.query('SELECT count(*)::int AS n FROM society_members WHERE society_id = $1', [s.id]);
    expect(n.rows[0].n).toBe(0);
  });
});

describe('heads', () => {
  it('admin makes someone a head: they become a society head and a member, and are told', async () => {
    const s = await make();
    t.push.reset();
    expect((await t.call('PUT', `/v1/societies/${s.id}/heads/${ayesha.id}`, { token: ayesha.token })).status).toBe(403);
    expect((await t.call('PUT', `/v1/societies/${s.id}/heads/${ayesha.id}`, { token: admin.token })).status).toBe(200);
    const me = await t.call('GET', '/v1/me', { token: ayesha.token });
    expect(me.body.membership.role).toBe('society_head');
    expect((await list(ayesha)).find(x => x.id === s.id)).toMatchObject({ myRole: 'head', memberCount: 1 });
    expect(t.push.sent.at(-1)?.userIds).toEqual([ayesha.id]);
  });

  it('a head can only post and create events for THEIR society', async () => {
    const mine = await make('Mine');
    const other = await make('Other');
    await t.call('PUT', `/v1/societies/${mine.id}/heads/${ayesha.id}`, { token: admin.token });
    const post = (societyId?: string) =>
      t.call('POST', '/v1/posts', { token: ayesha.token, body: { kind: 'society', title: 'Meeting today', body: 'We meet at five in the hall.', societyId } });

    const ok = await post(mine.id);
    expect(ok.status).toBe(201);
    expect(ok.body.source).toBe('Mine'); // the byline is the society's own name, not whatever the app sent
    expect(ok.body.societyId).toBe(mine.id);
    expect((await post(other.id)).status).toBe(403);
    expect((await post()).status).toBe(400);

    const ev = (societyId?: string) => t.call('POST', '/v1/events', { token: ayesha.token, body: eventBody({ societyId }) });
    const made = await ev(mine.id);
    expect(made.status).toBe(201);
    expect(made.body.organizer).toBe('Mine');
    expect(made.body.societyId).toBe(mine.id);
    expect((await ev(other.id)).status).toBe(403);
    expect((await ev()).status).toBe(403);
  });

  it('an update that is not from a society cannot claim one', async () => {
    const s = await make();
    const r = await t.call('POST', '/v1/posts', { token: admin.token, body: { kind: 'official', title: 'Notice', body: 'A normal notice for all.', source: 'Office', societyId: s.id } });
    expect(r.status).toBe(400);
  });

  it('removing the last headship takes the society-head role away again', async () => {
    const a = await make('Alpha Club');
    const b = await make('Beta Club');
    await t.call('PUT', `/v1/societies/${a.id}/heads/${ayesha.id}`, { token: admin.token });
    await t.call('PUT', `/v1/societies/${b.id}/heads/${ayesha.id}`, { token: admin.token });
    await t.call('DELETE', `/v1/societies/${a.id}/heads/${ayesha.id}`, { token: admin.token });
    expect((await t.call('GET', '/v1/me', { token: ayesha.token })).body.membership.role).toBe('society_head'); // still heads B
    await t.call('DELETE', `/v1/societies/${b.id}/heads/${ayesha.id}`, { token: admin.token });
    expect((await t.call('GET', '/v1/me', { token: ayesha.token })).body.membership.role).toBe('student');
  });

  it('someone from another university cannot be made a head', async () => {
    const s = await make();
    expect((await t.call('PUT', `/v1/societies/${s.id}/heads/${outsider.id}`, { token: admin.token })).status).toBe(404);
  });
});

describe('editing and deleting', () => {
  it('the head or an admin edits; a plain member cannot', async () => {
    const s = await make();
    await t.call('PUT', `/v1/societies/${s.id}/heads/${ayesha.id}`, { token: admin.token });
    await t.call('PUT', `/v1/societies/${s.id}/join`, { token: bilal.token });
    expect((await t.call('PATCH', `/v1/societies/${s.id}`, { token: bilal.token, body: { about: 'Hacked' } })).status).toBe(403);
    const ok = await t.call('PATCH', `/v1/societies/${s.id}`, { token: ayesha.token, body: { about: 'New about text' } });
    expect(ok.body.about).toBe('New about text');
    expect((await t.call('PATCH', `/v1/societies/${s.id}`, { token: admin.token, body: { category: 'Tech' } })).body.category).toBe('Tech');
  });

  it('deleting a society keeps its posts and events, demotes its heads and removes the members', async () => {
    const s = await make();
    await t.call('PUT', `/v1/societies/${s.id}/heads/${ayesha.id}`, { token: admin.token });
    const post = await t.call('POST', '/v1/posts', { token: ayesha.token, body: { kind: 'society', title: 'Hello all', body: 'A post from the society.', societyId: s.id } });
    const ev = await t.call('POST', '/v1/events', { token: ayesha.token, body: eventBody({ societyId: s.id }) });

    expect((await t.call('DELETE', `/v1/societies/${s.id}`, { token: ayesha.token })).status).toBe(403);
    expect((await t.call('DELETE', `/v1/societies/${s.id}`, { token: admin.token })).status).toBe(204);

    expect((await t.call('GET', `/v1/societies/${s.id}`, { token: admin.token })).status).toBe(404);
    const row = await t.pool.query('SELECT society_id FROM posts WHERE id = $1', [post.body.id]);
    expect(row.rows[0].society_id).toBeNull();
    const evRow = await t.pool.query('SELECT society_id, organizer FROM events WHERE id = $1', [ev.body.id]);
    expect(evRow.rows[0].society_id).toBeNull();
    expect((await t.call('GET', '/v1/me', { token: ayesha.token })).body.membership.role).toBe('student');
  });

  it('shows heads, upcoming events and recent updates on the detail page', async () => {
    const s = await make();
    await t.call('PUT', `/v1/societies/${s.id}/heads/${ayesha.id}`, { token: admin.token });
    await t.call('POST', '/v1/posts', { token: ayesha.token, body: { kind: 'society', title: 'Welcome everyone', body: 'The first post of the society.', societyId: s.id } });
    await t.call('POST', '/v1/events', { token: ayesha.token, body: eventBody({ societyId: s.id, title: 'Kick-off' }) });
    const d = (await t.call('GET', `/v1/societies/${s.id}`, { token: bilal.token })).body;
    expect(d.heads.map((h: any) => h.name)).toEqual(['Ayesha']);
    expect(d.upcomingEvents.map((e: any) => e.title)).toEqual(['Kick-off']);
    expect(d.recentPosts.map((p: any) => p.title)).toEqual(['Welcome everyone']);
  });
});

describe('isolation between universities', () => {
  it('another university cannot see, join, edit or list a society', async () => {
    const s = await make();
    expect((await list(outsider)).map(x => x.id)).not.toContain(s.id);
    for (const [method, url] of [
      ['GET', `/v1/societies/${s.id}`],
      ['GET', `/v1/societies/${s.id}/members`],
      ['PUT', `/v1/societies/${s.id}/join`],
      ['DELETE', `/v1/societies/${s.id}/join`],
    ] as const) {
      expect((await t.call(method, url, { token: outsider.token })).status, `${method} ${url}`).toBe(404);
    }
    const uolAdmin = await t.user({ email: 'admin@uol.test', uni: 'uol', role: 'uni_admin' });
    expect((await t.call('PATCH', `/v1/societies/${s.id}`, { token: uolAdmin.token, body: { about: 'x' } })).status).toBe(403);
    expect((await t.call('DELETE', `/v1/societies/${s.id}`, { token: uolAdmin.token })).status).toBe(404);
  });

  it('the database itself refuses a member from another university, even if the code were wrong', async () => {
    const s = await make();
    await expect(
      t.pool.query('INSERT INTO society_members (society_id, user_id, university_id) VALUES ($1, $2, $3)', [s.id, outsider.id, 'iac']),
    ).rejects.toThrow(); // omar belongs to uol, not iac
    await expect(
      t.pool.query('INSERT INTO society_members (society_id, user_id, university_id) VALUES ($1, $2, $3)', [s.id, outsider.id, 'uol']),
    ).rejects.toThrow(); // the society belongs to iac, not uol
  });

  it('an event or post of one university cannot point at another university’s society', async () => {
    const s = await make();
    const uolAdmin = await t.user({ email: 'admin@uol.test', uni: 'uol', role: 'uni_admin' });
    const ev = await t.call('POST', '/v1/events', { token: uolAdmin.token, body: eventBody() });
    await expect(t.pool.query('UPDATE events SET society_id = $1 WHERE id = $2', [s.id, ev.body.id])).rejects.toThrow();
  });
});
