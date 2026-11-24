import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
  ayesha = await t.user({ email: 'ayesha@iac.test', name: 'Ayesha Khan', uni: 'iac' });
  bilal = await t.user({ email: 'bilal@iac.test', name: 'Bilal Ahmed', uni: 'iac' });
  sara = await t.user({ email: 'sara@iac.test', name: 'Sara Malik', uni: 'iac' });
  outsider = await t.user({ email: 'omar@uol.test', name: 'Omar', uni: 'uol' });
});

const dm = async (from: TestUser, to: TestUser) => {
  const r = await t.call('POST', '/v1/chats/dm', { token: from.token, body: { userId: to.id } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.id as string;
};
const say = (id: string, from: TestUser, body: string) => t.call('POST', `/v1/chats/${id}/messages`, { token: from.token, body: { body } });
const thread = async (id: string, as: TestUser, qs = '') => (await t.call('GET', `/v1/chats/${id}/messages${qs}`, { token: as.token })).body.messages as any[];

describe('one-to-one chat', () => {
  it('two students talk; the same chat is found again from either side', async () => {
    const id = await dm(ayesha, bilal);
    expect(await dm(bilal, ayesha)).toBe(id);
    expect((await say(id, ayesha, 'Hi Bilal, do you have the CS201 notes?')).status).toBe(201);
    expect((await say(id, bilal, 'Yes, sending now')).status).toBe(201);
    const seen = await thread(id, ayesha);
    expect(seen.map(m => [m.senderName, m.mine])).toEqual([['Ayesha Khan', true], ['Bilal Ahmed', false]]);
  });

  it('the other person is notified; their phone shows the message', async () => {
    const id = await dm(ayesha, bilal);
    t.push.reset();
    await say(id, ayesha, 'Are you coming to the hackathon?');
    const sent = t.push.sent.filter(m => m.userIds.includes(bilal.id));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message.title).toBe('Ayesha Khan');
  });

  it('a chat appears in the list once it has a message, with unread counts that clear when read', async () => {
    const id = await dm(ayesha, bilal);
    expect((await t.call('GET', '/v1/chats', { token: bilal.token })).body.chats).toEqual([]); // nothing said yet
    await say(id, ayesha, 'One');
    await say(id, ayesha, 'Two');
    const mine = (await t.call('GET', '/v1/chats', { token: bilal.token })).body.chats[0];
    expect(mine).toMatchObject({ kind: 'dm', title: 'Ayesha Khan', unread: 2, otherUserId: ayesha.id });
    expect(mine.lastMessage.body).toBe('Two');
    expect((await t.call('GET', '/v1/chats', { token: ayesha.token })).body.chats[0].unread).toBe(0); // my own messages never count
    await t.call('POST', `/v1/chats/${id}/read`, { token: bilal.token });
    expect((await t.call('GET', '/v1/chats', { token: bilal.token })).body.chats[0].unread).toBe(0);
  });

  it('polling with "after" returns only what is new', async () => {
    const id = await dm(ayesha, bilal);
    await say(id, ayesha, 'first');
    const first = await thread(id, bilal);
    await new Promise(r => setTimeout(r, 15));
    await say(id, ayesha, 'second');
    expect((await thread(id, bilal, `?after=${first[0].createdAt}`)).map(m => m.body)).toEqual(['second']);
  });

  it('a third person cannot read, send or mark a chat that is not theirs', async () => {
    const id = await dm(ayesha, bilal);
    await say(id, ayesha, 'private');
    for (const who of [sara, outsider, admin]) {
      expect((await t.call('GET', `/v1/chats/${id}/messages`, { token: who.token })).status).toBe(404);
      expect((await say(id, who, 'hello')).status).toBe(404);
      expect((await t.call('POST', `/v1/chats/${id}/read`, { token: who.token })).status).toBe(404);
    }
  });

  it('only people at your own university, and not yourself', async () => {
    expect((await t.call('POST', '/v1/chats/dm', { token: ayesha.token, body: { userId: outsider.id } })).status).toBe(404);
    expect((await t.call('POST', '/v1/chats/dm', { token: ayesha.token, body: { userId: ayesha.id } })).status).toBe(400);
    const pending = await t.user({ email: 'new@iac.test', uni: 'iac', status: 'pending' });
    expect((await t.call('POST', '/v1/chats/dm', { token: ayesha.token, body: { userId: pending.id } })).status).toBe(404);
  });

  it('validates the message', async () => {
    const id = await dm(ayesha, bilal);
    expect((await say(id, ayesha, '   ')).status).toBe(400);
    expect((await say(id, ayesha, 'x'.repeat(1001))).status).toBe(400);
    expect((await say(id, ayesha, '😀 مرحبا <b>hi</b>')).status).toBe(201); // any text is stored as text
  });

  it('finds people by name at your university only', async () => {
    const find = async (u: TestUser, q: string) => (await t.call('GET', `/v1/people?q=${encodeURIComponent(q)}`, { token: u.token })).body.people.map((p: any) => p.name);
    expect(await find(ayesha, 'mal')).toEqual(['Sara Malik']);
    expect(await find(ayesha, 'omar')).toEqual([]);
    expect(await find(ayesha, 'ayesha')).toEqual([]); // not yourself
    expect(await find(ayesha, '%')).toEqual([]); // a % is text, not a wildcard
  });

  it('shows a public profile card with no private details, and hides blocked people', async () => {
    const card = (await t.call('GET', `/v1/people/${bilal.id}`, { token: ayesha.token })).body;
    expect(card).toMatchObject({ uid: bilal.id, name: 'Bilal Ahmed', role: 'student' });
    expect(Array.isArray(card.societies)).toBe(true);
    expect(JSON.stringify(card)).not.toMatch(/email|studentId|IAC-/);
    expect((await t.call('GET', '/v1/people/00000000-0000-4000-8000-000000000000', { token: ayesha.token })).status).toBe(404);
    await t.call('PUT', `/v1/users/${bilal.id}/block`, { token: ayesha.token });
    expect((await t.call('GET', `/v1/people/${bilal.id}`, { token: ayesha.token })).status).toBe(404);
  });
});

describe('blocking', () => {
  it('a blocked person cannot start or continue a chat, and cannot be found', async () => {
    const id = await dm(ayesha, bilal);
    await say(id, bilal, 'hello');
    await t.call('PUT', `/v1/users/${bilal.id}/block`, { token: ayesha.token });
    expect((await say(id, bilal, 'please reply')).status).toBe(403);
    expect((await say(id, ayesha, 'no')).status).toBe(403);
    expect((await t.call('POST', '/v1/chats/dm', { token: bilal.token, body: { userId: ayesha.id } })).status).toBe(403);
    expect((await t.call('GET', '/v1/chats', { token: ayesha.token })).body.chats).toEqual([]);
    expect((await t.call('GET', '/v1/people?q=bilal', { token: ayesha.token })).body.people).toEqual([]);
    expect((await t.call('GET', '/v1/people?q=ayesha', { token: bilal.token })).body.people).toEqual([]);
    expect((await t.call('GET', '/v1/blocks', { token: ayesha.token })).body.blocked.map((b: any) => b.name)).toEqual(['Bilal Ahmed']);
  });

  it('unblocking brings the chat back', async () => {
    const id = await dm(ayesha, bilal);
    await say(id, bilal, 'hello');
    await t.call('PUT', `/v1/users/${bilal.id}/block`, { token: ayesha.token });
    await t.call('DELETE', `/v1/users/${bilal.id}/block`, { token: ayesha.token });
    expect((await say(id, bilal, 'back again')).status).toBe(201);
    expect((await t.call('GET', '/v1/chats', { token: ayesha.token })).body.chats).toHaveLength(1);
  });

  it('blocking hides someone’s messages in a shared room', async () => {
    const g = (await t.call('POST', '/v1/study-groups', { token: ayesha.token, body: { title: 'Exam prep', capacity: 5 } })).body;
    await t.call('PUT', `/v1/study-groups/${g.id}/join`, { token: bilal.token });
    await t.call('PUT', `/v1/study-groups/${g.id}/join`, { token: sara.token });
    const room = (await t.call('GET', '/v1/chats', { token: ayesha.token })).body.chats.find((c: any) => c.kind === 'group').id;
    await say(room, bilal, 'from bilal');
    await say(room, sara, 'from sara');
    await t.call('PUT', `/v1/users/${bilal.id}/block`, { token: ayesha.token });
    expect((await thread(room, ayesha)).map(m => m.senderName)).toEqual(['Sara Malik']);
    expect((await thread(room, sara)).map(m => m.senderName)).toEqual(['Bilal Ahmed', 'Sara Malik']); // others still see it
  });

  it('cannot block yourself or someone from another university', async () => {
    expect((await t.call('PUT', `/v1/users/${ayesha.id}/block`, { token: ayesha.token })).status).toBe(400);
    expect((await t.call('PUT', `/v1/users/${outsider.id}/block`, { token: ayesha.token })).status).toBe(404);
  });
});

describe('society and study-group rooms', () => {
  it('only members get the room; leaving removes it', async () => {
    const s = (await t.call('POST', '/v1/societies', { token: admin.token, body: { name: 'Coding Club', category: 'Tech' } })).body;
    await t.call('PUT', `/v1/societies/${s.id}/join`, { token: ayesha.token });
    const list = (await t.call('GET', '/v1/chats', { token: ayesha.token })).body.chats;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'society', title: 'Coding Club', memberCount: 1 });
    const room = list[0].id;
    expect((await say(room, ayesha, 'Welcome everyone')).status).toBe(201);
    expect((await t.call('GET', `/v1/chats/${room}/messages`, { token: bilal.token })).status).toBe(404); // not a member
    await t.call('PUT', `/v1/societies/${s.id}/join`, { token: bilal.token });
    expect((await thread(room, bilal)).map(m => m.body)).toEqual(['Welcome everyone']);
    await t.call('DELETE', `/v1/societies/${s.id}/join`, { token: bilal.token });
    expect((await t.call('GET', `/v1/chats/${room}/messages`, { token: bilal.token })).status).toBe(404);
    expect((await t.call('GET', '/v1/chats', { token: bilal.token })).body.chats).toEqual([]);
  });

  it('rooms do not push to every member', async () => {
    const g = (await t.call('POST', '/v1/study-groups', { token: ayesha.token, body: { title: 'Quiet group' } })).body;
    await t.call('PUT', `/v1/study-groups/${g.id}/join`, { token: bilal.token });
    const room = (await t.call('GET', '/v1/chats', { token: ayesha.token })).body.chats[0].id;
    t.push.reset();
    await say(room, ayesha, 'hello all');
    expect(t.push.sent).toEqual([]);
  });

  it('a room is gone when its group is deleted', async () => {
    const g = (await t.call('POST', '/v1/study-groups', { token: ayesha.token, body: { title: 'Short lived' } })).body;
    const room = (await t.call('GET', '/v1/chats', { token: ayesha.token })).body.chats[0].id;
    await say(room, ayesha, 'hi');
    await t.call('DELETE', `/v1/study-groups/${g.id}`, { token: ayesha.token });
    expect((await t.pool.query('SELECT count(*)::int AS n FROM messages')).rows[0].n).toBe(0);
    expect((await t.call('GET', '/v1/chats', { token: ayesha.token })).body.chats).toEqual([]);
  });

  it('another university never sees these rooms', async () => {
    const g = (await t.call('POST', '/v1/study-groups', { token: ayesha.token, body: { title: 'Private to IAC' } })).body;
    const room = (await t.call('GET', '/v1/chats', { token: ayesha.token })).body.chats[0].id;
    expect((await t.call('GET', `/v1/chats/${room}/messages`, { token: outsider.token })).status).toBe(404);
    await expect(t.pool.query(`INSERT INTO messages (conversation_id, university_id, sender_id, body) VALUES ($1, 'uol', $2, 'x')`, [room, outsider.id])).rejects.toThrow();
    expect(g.id).toBeTruthy();
  });
});

describe('cleanup and moderation', () => {
  it('leaving the university removes your messages and your one-to-one chats', async () => {
    const id = await dm(ayesha, bilal);
    await say(id, ayesha, 'bye');
    await t.call('DELETE', '/v1/membership', { token: ayesha.token });
    expect((await t.pool.query('SELECT count(*)::int AS n FROM messages')).rows[0].n).toBe(0);
    expect((await t.pool.query('SELECT count(*)::int AS n FROM conversations')).rows[0].n).toBe(0);
  });

  it('a message can be reported only by someone who can read it; admins remove it', async () => {
    const id = await dm(ayesha, bilal);
    const msg = (await say(id, bilal, 'rude words')).body;
    const report = (u: TestUser) => t.call('POST', '/v1/reports', { token: u.token, body: { targetType: 'message', targetId: msg.id, reason: 'harassment' } });
    expect((await report(sara)).status).toBe(404); // not part of the chat
    expect((await report(bilal)).status).toBe(400); // your own message
    expect((await report(ayesha)).status).toBe(201);
    const open = (await t.call('GET', '/v1/admin/reports', { token: admin.token })).body.reports;
    expect(open[0]).toMatchObject({ targetType: 'message', title: 'rude words' });
    await t.call('POST', `/v1/admin/reports/${open[0].id}`, { token: admin.token, body: { action: 'remove' } });
    expect(await thread(id, ayesha)).toEqual([]);
  });

  it('a suspended student cannot use chat', async () => {
    const id = await dm(ayesha, bilal);
    await t.pool.query("UPDATE memberships SET status = 'suspended' WHERE user_id = $1", [ayesha.id]);
    expect((await say(id, ayesha, 'hi')).status).toBe(403);
    expect((await t.call('GET', '/v1/chats', { token: ayesha.token })).status).toBe(403);
    expect((await say(id, bilal, 'are you there')).status).toBe(409); // the other side is told they are unavailable
  });
});

describe('opening a room', () => {
  it('members open the room from the society or group; others are told to join first', async () => {
    const s = (await t.call('POST', '/v1/societies', { token: admin.token, body: { name: 'Debate Club', category: 'Cultural' } })).body;
    expect((await t.call('GET', `/v1/chats/society/${s.id}`, { token: ayesha.token })).status).toBe(403);
    await t.call('PUT', `/v1/societies/${s.id}/join`, { token: ayesha.token });
    const r = (await t.call('GET', `/v1/chats/society/${s.id}`, { token: ayesha.token })).body;
    expect(r.title).toBe('Debate Club');
    expect((await t.call('GET', `/v1/chats/${r.id}/messages`, { token: ayesha.token })).status).toBe(200);
    expect((await t.call('GET', `/v1/chats/society/${s.id}`, { token: outsider.token })).status).toBe(403);
    const g = (await t.call('POST', '/v1/study-groups', { token: ayesha.token, body: { title: 'Evening revision' } })).body;
    expect((await t.call('GET', `/v1/chats/group/${g.id}`, { token: ayesha.token })).body.title).toBe('Evening revision');
    expect((await t.call('GET', `/v1/chats/group/${g.id}`, { token: bilal.token })).status).toBe(403);
  });
});