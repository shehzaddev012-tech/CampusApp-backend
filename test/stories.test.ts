import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { purgeExpiredStories } from '../src/modules/stories.js';
import { createStorage } from '../src/storage/index.js';
import { createCtx, type Ctx, type TestUser } from './helpers.js';

let t: Ctx;
let admin: TestUser;
let ayesha: TestUser;
let bilal: TestUser;
let cara: TestUser;
let outsider: TestUser;
let png: Buffer;

beforeAll(async () => {
  t = await createCtx();
  png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#4F46E5' } }).jpeg().toBuffer();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  await t.universe('iac');
  await t.universe('uol');
  admin = await t.user({ email: 'admin@iac.test', name: 'Admin', uni: 'iac', role: 'uni_admin' });
  ayesha = await t.user({ email: 'ayesha@iac.test', name: 'Ayesha', uni: 'iac' });
  bilal = await t.user({ email: 'bilal@iac.test', name: 'Bilal', uni: 'iac' });
  cara = await t.user({ email: 'cara@iac.test', name: 'Cara', uni: 'iac', status: 'pending' });
  outsider = await t.user({ email: 'out@uol.test', name: 'Outsider', uni: 'uol' });
});

const post = (u: TestUser, caption = 'Hello campus', data: Buffer = png) => t.upload('/v1/stories', u.token, [{ name: 's.jpg', data }], { caption });
const feed = async (u: TestUser) => (await t.call('GET', '/v1/stories', { token: u.token })).body.people as { uid: string; name: string; mine: boolean; hasUnseen: boolean; stories: { id: string; seen: boolean; viewCount: number | null; image: { url: string } }[] }[];

describe('posting', () => {
  it('stores a picture and a line, and it lasts 24 hours', async () => {
    const r = await post(ayesha);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.caption).toBe('Hello campus');
    expect(r.body.expiresAt - r.body.createdAt).toBe(24 * 3_600_000);
    const pic = await t.app.inject({ method: 'GET', url: r.body.image.url });
    expect(pic.statusCode).toBe(200);
    expect(pic.headers['content-type']).toBe('image/jpeg');
  });

  it('rejects non-images, too-long lines, no file, and people who are not approved members', async () => {
    expect((await post(ayesha, 'x', Buffer.from('not a picture at all'))).status).toBe(400);
    expect((await post(ayesha, 'y'.repeat(141))).status).toBe(400);
    expect((await t.upload('/v1/stories', ayesha.token, [], {})).status).toBe(400); // neither words nor picture
    expect((await t.upload('/v1/stories', ayesha.token, [], { caption: 'z'.repeat(281) })).status).toBe(400);
    expect((await post(cara)).status).toBe(403);
    expect((await t.call('POST', '/v1/stories', {})).status).toBe(401);
  });

  it('allows a story made only of words on a coloured background', async () => {
    const r = await t.upload('/v1/stories', ayesha.token, [], { caption: 'Exam week, good luck everyone', bg: '#2B5FA8' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.image).toBeNull();
    expect(r.body.bg).toBe('#2B5FA8');
    const mine = (await feed(ayesha)).find(p => p.mine);
    expect(mine?.stories[0]?.image).toBeNull();
    // anyone else at the university sees it too, and the owner can delete it
    expect((await feed(bilal)).some(p => p.uid === ayesha.id)).toBe(true);
    expect((await t.call('DELETE', `/v1/stories/${r.body.id}`, { token: ayesha.token })).status).toBe(204);
  });

  it('allows at most 10 live stories per person', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await post(ayesha, `s${i}`)).status).toBe(201);
    }
    const r = await post(ayesha, 'one too many');
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('too_many_stories');
  });
});

describe('the story row', () => {
  it('shows my university’s live stories, mine first, grouped by person', async () => {
    await post(bilal, 'b1');
    await post(ayesha, 'a1');
    await post(ayesha, 'a2');
    const mine = await feed(ayesha);
    expect(mine.map(p => p.name)).toEqual(['Ayesha', 'Bilal']);
    expect(mine[0]?.mine).toBe(true);
    expect(mine[0]?.stories.map(s => s.id)).toHaveLength(2);
    expect((await feed(outsider))).toEqual([]); // another university sees nothing
  });

  it('puts people with unseen stories first and marks them seen after a view', async () => {
    const a = (await post(ayesha, 'a1')).body;
    await post(bilal, 'b1');
    let list = await feed(admin);
    expect(list.every(p => p.hasUnseen)).toBe(true);
    expect((await t.call('POST', `/v1/stories/${a.id}/view`, { token: admin.token })).status).toBe(204);
    list = await feed(admin);
    expect(list.map(p => p.name)).toEqual(['Bilal', 'Ayesha']); // Ayesha is now seen, so Bilal comes first
    expect(list.find(p => p.name === 'Ayesha')?.hasUnseen).toBe(false);
  });

  it('hides expired stories and purges them with their pictures', async () => {
    const a = (await post(ayesha, 'old')).body;
    await t.pool.query("UPDATE stories SET expires_at = now() - interval '1 minute' WHERE id = $1", [a.id]);
    expect(await feed(ayesha)).toEqual([]);
    expect((await t.call('POST', `/v1/stories/${a.id}/view`, { token: bilal.token })).status).toBe(404);
    expect(await purgeExpiredStories(t.pool, createStorage(t.config.uploadsDir))).toBe(1);
    expect((await t.pool.query('SELECT 1 FROM media')).rowCount).toBe(0);
  });
});

describe('who can see what', () => {
  it('hides stories both ways once someone is blocked', async () => {
    const a = (await post(ayesha, 'a1')).body;
    await post(bilal, 'b1');
    await t.call('PUT', `/v1/users/${bilal.id}/block`, { token: ayesha.token });
    expect((await feed(ayesha)).map(p => p.name)).toEqual(['Ayesha']);
    expect((await feed(bilal)).map(p => p.name)).toEqual(['Bilal']);
    expect((await t.call('POST', `/v1/stories/${a.id}/view`, { token: bilal.token })).status).toBe(404);
  });

  it('only the owner sees view counts and the list of viewers', async () => {
    const a = (await post(ayesha, 'a1')).body;
    await t.call('POST', `/v1/stories/${a.id}/view`, { token: bilal.token });
    await t.call('POST', `/v1/stories/${a.id}/view`, { token: bilal.token }); // counted once
    await t.call('POST', `/v1/stories/${a.id}/view`, { token: ayesha.token }); // the owner looking is not a view
    const ownerSees = (await feed(ayesha))[0]?.stories[0];
    expect(ownerSees?.viewCount).toBe(1);
    expect((await feed(bilal))[0]?.stories[0]?.viewCount).toBeNull();
    const viewers = await t.call('GET', `/v1/stories/${a.id}/viewers`, { token: ayesha.token });
    expect(viewers.body.viewers.map((v: { name: string }) => v.name)).toEqual(['Bilal']);
    expect((await t.call('GET', `/v1/stories/${a.id}/viewers`, { token: bilal.token })).status).toBe(403);
    expect((await t.call('GET', `/v1/stories/${a.id}/viewers`, { token: admin.token })).status).toBe(403);
  });

  it('another university cannot view or delete it', async () => {
    const a = (await post(ayesha, 'a1')).body;
    expect((await t.call('POST', `/v1/stories/${a.id}/view`, { token: outsider.token })).status).toBe(404);
    expect((await t.call('DELETE', `/v1/stories/${a.id}`, { token: outsider.token })).status).toBe(404);
  });
});

describe('deleting and reporting', () => {
  it('lets the owner and an admin delete, not other students', async () => {
    const a = (await post(ayesha, 'a1')).body;
    const b = (await post(ayesha, 'a2')).body;
    expect((await t.call('DELETE', `/v1/stories/${a.id}`, { token: bilal.token })).status).toBe(403);
    expect((await t.call('DELETE', `/v1/stories/${a.id}`, { token: ayesha.token })).status).toBe(204);
    expect((await t.call('DELETE', `/v1/stories/${b.id}`, { token: admin.token })).status).toBe(204);
    expect((await t.pool.query('SELECT 1 FROM media')).rowCount).toBe(0); // the pictures went too
  });

  it('can be reported, and an admin removing it deletes it', async () => {
    const a = (await post(ayesha, 'rude')).body;
    expect((await t.call('POST', '/v1/reports', { token: ayesha.token, body: { targetType: 'story', targetId: a.id, reason: 'spam' } })).status).toBe(400); // own story
    expect((await t.call('POST', '/v1/reports', { token: bilal.token, body: { targetType: 'story', targetId: a.id, reason: 'inappropriate' } })).status).toBe(201);
    expect((await t.call('POST', '/v1/reports', { token: outsider.token, body: { targetType: 'story', targetId: a.id, reason: 'spam' } })).status).toBe(404);
    const list = (await t.call('GET', '/v1/admin/reports', { token: admin.token })).body.reports;
    expect(list[0].title).toContain('rude');
    expect((await t.call('POST', `/v1/admin/reports/${list[0].id}`, { token: admin.token, body: { action: 'remove' } })).status).toBe(200);
    expect(await feed(ayesha)).toEqual([]);
  });
});
