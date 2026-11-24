import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { cardPayload, verifyCardPayload } from '../src/modules/card.js';
import { createCtx, type Ctx, type TestUser } from './helpers.js';

let t: Ctx;
let admin: TestUser;
let security: TestUser;
let ayesha: TestUser;
let bilal: TestUser;
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
  security = await t.user({ email: 'sec@iac.test', name: 'Gate Security', uni: 'iac', role: 'security' });
  ayesha = await t.user({ email: 'ayesha@iac.test', name: 'Ayesha Khan', uni: 'iac', studentId: '22-CS-104' });
  bilal = await t.user({ email: 'bilal@iac.test', name: 'Bilal Ahmed', uni: 'iac' });
  outsider = await t.user({ email: 'omar@uol.test', name: 'Omar', uni: 'uol' });
});

const post = async (by: TestUser, over: Record<string, unknown> = {}) => {
  const r = await t.call('POST', '/v1/lost-found', { token: by.token, body: { kind: 'lost', title: 'Blue water bottle', description: 'Steel, with stickers', place: 'Library', ...over } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};

describe('lost and found', () => {
  it('lists open items of my university, newest first', async () => {
    await post(ayesha, { title: 'First item' });
    await post(bilal, { kind: 'found', title: 'Second item' });
    const list = (await t.call('GET', '/v1/lost-found', { token: security.token })).body.items;
    expect(list.map((i: any) => i.title)).toEqual(['Second item', 'First item']);
    expect(list[0]).toMatchObject({ kind: 'found', postedBy: 'Bilal Ahmed', mine: false });
    expect((await t.call('GET', '/v1/lost-found', { token: outsider.token })).body.items).toEqual([]);
  });

  it('validates what is posted', async () => {
    const bad = async (over: Record<string, unknown>) => (await t.call('POST', '/v1/lost-found', { token: ayesha.token, body: { kind: 'lost', title: 'Valid title', ...over } })).status;
    expect(await bad({ title: 'ab' })).toBe(400);
    expect(await bad({ kind: 'stolen' })).toBe(400);
    expect(await bad({ description: 'x'.repeat(501) })).toBe(400);
  });

  it('a reply tells the poster once; you cannot reply to yourself; only the poster sees who replied', async () => {
    const item = await post(ayesha);
    t.push.reset();
    expect((await t.call('POST', `/v1/lost-found/${item.id}/reply`, { token: ayesha.token })).status).toBe(403);
    expect((await t.call('POST', `/v1/lost-found/${item.id}/reply`, { token: bilal.token })).status).toBe(200);
    expect((await t.call('POST', `/v1/lost-found/${item.id}/reply`, { token: bilal.token })).status).toBe(200); // again: nothing new sent
    const told = t.push.sent.filter(m => m.userIds.includes(ayesha.id));
    expect(told).toHaveLength(1);
    expect(told[0]?.message.body).toContain('Bilal Ahmed');

    const replies = (await t.call('GET', `/v1/lost-found/${item.id}/replies`, { token: ayesha.token })).body.replies;
    expect(replies.map((r: any) => r.name)).toEqual(['Bilal Ahmed']);
    expect((await t.call('GET', `/v1/lost-found/${item.id}/replies`, { token: bilal.token })).status).toBe(403);
    const mine = (await t.call('GET', '/v1/lost-found', { token: ayesha.token })).body.items[0];
    expect(mine).toMatchObject({ mine: true, replies: 1 });
    const theirs = (await t.call('GET', '/v1/lost-found', { token: bilal.token })).body.items[0];
    expect(theirs).toMatchObject({ iReplied: true, replies: null });
  });

  it('the poster or an admin closes or deletes it; others cannot', async () => {
    const item = await post(ayesha);
    expect((await t.call('POST', `/v1/lost-found/${item.id}/resolve`, { token: bilal.token })).status).toBe(403);
    expect((await t.call('DELETE', `/v1/lost-found/${item.id}`, { token: bilal.token })).status).toBe(403);
    const done = await t.call('POST', `/v1/lost-found/${item.id}/resolve`, { token: ayesha.token });
    expect(done.body.status).toBe('resolved');
    expect((await t.call('GET', '/v1/lost-found', { token: bilal.token })).body.items).toEqual([]);
    expect((await t.call('GET', '/v1/lost-found?status=resolved', { token: bilal.token })).body.items).toHaveLength(1);
    expect((await t.call('POST', `/v1/lost-found/${item.id}/reply`, { token: bilal.token })).status).toBe(409);
    expect((await t.call('DELETE', `/v1/lost-found/${item.id}`, { token: admin.token })).status).toBe(204);
  });

  it('another university cannot see, reply to or change an item', async () => {
    const item = await post(ayesha);
    for (const [method, url] of [
      ['POST', `/v1/lost-found/${item.id}/reply`],
      ['GET', `/v1/lost-found/${item.id}/replies`],
      ['POST', `/v1/lost-found/${item.id}/resolve`],
      ['DELETE', `/v1/lost-found/${item.id}`],
    ] as const) {
      expect((await t.call(method, url, { token: outsider.token })).status, `${method} ${url}`).toBe(404);
    }
  });

  it('leaving the university removes what you posted', async () => {
    await post(ayesha);
    await t.call('DELETE', '/v1/membership', { token: ayesha.token });
    expect((await t.pool.query('SELECT count(*)::int AS n FROM lost_items')).rows[0].n).toBe(0);
  });
});

describe('student card', () => {
  it('gives a signed code that changes every 30 seconds, and the card details', async () => {
    const card = (await t.call('GET', '/v1/card', { token: ayesha.token })).body;
    expect(card).toMatchObject({ name: 'Ayesha Khan', studentId: '22-CS-104', university: { id: 'iac' } });
    expect(card.payload).toMatch(/^CH1\|C\|iac\|/);
    expect(card.refreshAt).toBeGreaterThan(Date.now());
    const later = cardPayload(t.config, 'iac', ayesha.id, Date.now() + 31_000).payload;
    expect(later).not.toBe(cardPayload(t.config, 'iac', ayesha.id).payload);
  });

  it('gate staff can verify it and see who the person is', async () => {
    const { payload } = (await t.call('GET', '/v1/card', { token: ayesha.token })).body;
    const r = await t.call('POST', '/v1/card/verify', { token: security.token, body: { payload } });
    expect(r.body).toMatchObject({ ok: true, name: 'Ayesha Khan', studentId: '22-CS-104', detail: 'Verified student' });
    expect((await t.call('POST', '/v1/card/verify', { token: bilal.token, body: { payload } })).status).toBe(403); // students cannot scan
  });

  it('refuses a tampered, expired, foreign or made-up code', async () => {
    const verify = async (payload: string, as: TestUser = security) => (await t.call('POST', '/v1/card/verify', { token: as.token, body: { payload } })).body;
    const good = cardPayload(t.config, 'iac', ayesha.id).payload;
    const parts = good.split('|');
    expect((await verify(`${parts.slice(0, 3).join('|')}|${bilal.id}|${parts[4]}|${parts[5]}`)).ok).toBe(false); // someone else's id, same signature
    expect((await verify(`${parts.slice(0, 5).join('|')}|AAAAAAAAAAAAAAAAAAAAAA`)).ok).toBe(false);
    expect((await verify(cardPayload(t.config, 'iac', ayesha.id, Date.now() - 5 * 60_000).payload)).reason).toBe('invalid'); // a screenshot from 5 minutes ago
    expect((await verify('CH1|C|iac|nonsense')).ok).toBe(false);
    const uolSecurity = await t.user({ email: 'sec@uol.test', uni: 'uol', role: 'security' });
    expect((await verify(good, uolSecurity)).reason).toBe('wrong_university');
    expect(verifyCardPayload(t.config, good)?.userId).toBe(ayesha.id);
  });

  it('says so when the person is no longer an active member', async () => {
    const { payload } = (await t.call('GET', '/v1/card', { token: ayesha.token })).body;
    await t.pool.query(`UPDATE memberships SET status = 'suspended' WHERE user_id = $1`, [ayesha.id]);
    const r = (await t.call('POST', '/v1/card/verify', { token: security.token, body: { payload } })).body;
    expect(r).toMatchObject({ ok: false, reason: 'not_active', name: 'Ayesha Khan' });
  });

  it('a student who has not been approved gets no card', async () => {
    const pending = await t.user({ email: 'new@iac.test', uni: 'iac', status: 'pending' });
    expect((await t.call('GET', '/v1/card', { token: pending.token })).status).toBe(403);
  });
});
