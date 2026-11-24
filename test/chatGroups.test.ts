import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createCtx, type Ctx, type TestUser } from './helpers.js';

let t: Ctx;
let ayesha: TestUser;
let bilal: TestUser;
let cara: TestUser;
let dana: TestUser;
let pending: TestUser;
let outsider: TestUser;

beforeAll(async () => {
  t = await createCtx();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  await t.universe('iac');
  await t.universe('uol');
  ayesha = await t.user({ email: 'ayesha@iac.test', name: 'Ayesha', uni: 'iac' });
  bilal = await t.user({ email: 'bilal@iac.test', name: 'Bilal', uni: 'iac' });
  cara = await t.user({ email: 'cara@iac.test', name: 'Cara', uni: 'iac' });
  dana = await t.user({ email: 'dana@iac.test', name: 'Dana', uni: 'iac' });
  pending = await t.user({ email: 'pending@iac.test', name: 'Pending', uni: 'iac', status: 'pending' });
  outsider = await t.user({ email: 'out@uol.test', name: 'Outsider', uni: 'uol' });
});

const create = async (by: TestUser, name = 'Study buddies', members: TestUser[] = [], extra: Record<string, unknown> = {}) => {
  const r = await t.call('POST', '/v1/chats/groups', { token: by.token, body: { name, memberIds: members.map(m => m.id), ...extra } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
};
const info = async (u: TestUser, id: string) => t.call('GET', `/v1/chats/groups/${id}`, { token: u.token });
const say = (u: TestUser, id: string, body: string) => t.call('POST', `/v1/chats/${id}/messages`, { token: u.token, body: { body } });
/** What people typed (the "X added Y" lines are tested on their own below). */
const read = async (u: TestUser, id: string) => (await t.call('GET', `/v1/chats/${id}/messages`, { token: u.token })).body.messages.filter((m: { kind: string }) => m.kind === 'text').map((m: { body: string }) => m.body) as string[];
const lines = async (u: TestUser, id: string) => (await t.call('GET', `/v1/chats/${id}/messages`, { token: u.token })).body.messages.filter((m: { kind: string }) => m.kind === 'system').map((m: { senderName: string; body: string }) => `${m.senderName} ${m.body}`) as string[];
const list = async (u: TestUser) => (await t.call('GET', '/v1/chats', { token: u.token })).body.chats as { id: string; kind: string; title: string; unread: number; memberCount: number; lastMessage: { body: string } | null }[];

describe('creating a group', () => {
  it('makes the creator an admin and shows members with their roles', async () => {
    const id = await create(ayesha, 'Study buddies', [bilal, cara]);
    const g = (await info(ayesha, id)).body;
    expect(g.myRole).toBe('admin');
    expect(g.members.map((m: { name: string; role: string }) => `${m.name}:${m.role}`)).toEqual(['Ayesha:admin', 'Bilal:member', 'Cara:member']);
    expect((await info(bilal, id)).body.myRole).toBe('member');
    const chats = await list(bilal);
    expect(chats.find(c => c.id === id)).toMatchObject({ kind: 'custom', title: 'Study buddies', memberCount: 3 });
  });

  it('validates the name and refuses people it cannot add', async () => {
    const bad = (body: Record<string, unknown>) => t.call('POST', '/v1/chats/groups', { token: ayesha.token, body });
    expect((await bad({ name: 'x', memberIds: [] })).status).toBe(400);
    expect((await bad({ name: 'Fine name', memberIds: [outsider.id] })).status).toBe(400); // another university
    expect((await bad({ name: 'Fine name', memberIds: [pending.id] })).status).toBe(400); // not approved
    await t.call('PUT', `/v1/users/${bilal.id}/block`, { token: ayesha.token });
    expect((await bad({ name: 'Fine name', memberIds: [bilal.id] })).status).toBe(400); // blocked
    expect((await t.call('POST', '/v1/chats/groups', { body: { name: 'No sign in' } })).status).toBe(401);
  });

  it('allows a group with only its creator', async () => {
    const id = await create(ayesha, 'Just me', []);
    expect((await say(ayesha, id, 'note to self')).status).toBe(201);
  });
});

describe('talking in a group', () => {
  it('delivers to every member and to nobody else', async () => {
    const id = await create(ayesha, 'Study buddies', [bilal, cara]);
    expect((await say(bilal, id, 'hello all')).status).toBe(201);
    expect(await read(cara, id)).toEqual(['hello all']);
    expect((await t.call('GET', `/v1/chats/${id}/messages`, { token: dana.token })).status).toBe(404); // not a member: it does not even exist for them
    expect((await say(dana, id, 'let me in')).status).toBe(404);
    expect((await t.call('GET', `/v1/chats/${id}/messages`, { token: outsider.token })).status).toBe(404);
    expect((await info(dana, id)).status).toBe(404);
  });

  it('counts unread messages for others, and pushes them, but not to the sender', async () => {
    const id = await create(ayesha, 'Study buddies', [bilal, cara]);
    t.push.reset();
    await say(ayesha, id, 'meeting at 4');
    expect((await list(bilal)).find(c => c.id === id)?.unread).toBe(1);
    expect((await list(ayesha)).find(c => c.id === id)?.unread).toBe(0);
    const sent = t.push.sent.find(s => s.message.title === 'Study buddies');
    expect(sent?.userIds.sort()).toEqual([bilal.id, cara.id].sort());
    expect(sent?.message.body).toBe('Ayesha: meeting at 4');
  });

  it('does not push to someone who blocked the sender, and hides the sender from them', async () => {
    const id = await create(ayesha, 'Study buddies', [bilal, cara]);
    await t.call('PUT', `/v1/users/${ayesha.id}/block`, { token: bilal.token });
    t.push.reset();
    await say(ayesha, id, 'hi');
    expect(t.push.sent.find(s => s.message.title === 'Study buddies')?.userIds).toEqual([cara.id]);
    expect(await read(bilal, id)).toEqual([]);
    expect(await read(cara, id)).toEqual(['hi']);
  });

  it('honours "only admins can send"', async () => {
    const id = await create(ayesha, 'Announcements', [bilal], { onlyAdminsPost: false });
    expect((await t.call('PATCH', `/v1/chats/groups/${id}`, { token: ayesha.token, body: { onlyAdminsPost: true } })).status).toBe(200);
    expect((await say(bilal, id, 'can I talk?')).status).toBe(403);
    expect((await say(ayesha, id, 'only I can')).status).toBe(201);
    await t.call('PUT', `/v1/chats/groups/${id}/admins/${bilal.id}`, { token: ayesha.token });
    expect((await say(bilal, id, 'now I can')).status).toBe(201);
  });
});

describe('who can manage the group', () => {
  it('lets only admins rename, add, remove and delete', async () => {
    const id = await create(ayesha, 'Study buddies', [bilal]);
    expect((await t.call('PATCH', `/v1/chats/groups/${id}`, { token: bilal.token, body: { name: 'Hacked' } })).status).toBe(403);
    expect((await t.call('POST', `/v1/chats/groups/${id}/members`, { token: bilal.token, body: { userIds: [cara.id] } })).status).toBe(403);
    expect((await t.call('DELETE', `/v1/chats/groups/${id}/members/${ayesha.id}`, { token: bilal.token })).status).toBe(403);
    expect((await t.call('DELETE', `/v1/chats/groups/${id}`, { token: bilal.token })).status).toBe(403);
    expect((await t.call('PATCH', `/v1/chats/groups/${id}`, { token: ayesha.token, body: { name: 'Renamed', about: 'Exam prep' } })).body).toMatchObject({ name: 'Renamed', about: 'Exam prep' });
  });

  it('adds people; a new member sees nothing said before they joined', async () => {
    const id = await create(ayesha, 'Study buddies', [bilal]);
    await say(bilal, id, 'secret before cara');
    await new Promise(r => setTimeout(r, 30));
    const add = await t.call('POST', `/v1/chats/groups/${id}/members`, { token: ayesha.token, body: { userIds: [cara.id] } });
    expect(add.status).toBe(200);
    expect(add.body.members).toHaveLength(3);
    expect(await read(cara, id)).toEqual([]);
    expect((await list(cara)).find(c => c.id === id)).toMatchObject({ unread: 0, lastMessage: { body: 'added Cara' } }); // only the line about their own joining
    await say(bilal, id, 'welcome cara');
    expect(await read(cara, id)).toEqual(['welcome cara']);
    expect(await read(bilal, id)).toEqual(['secret before cara', 'welcome cara']);
  });

  it('cannot add another university, an unapproved person, or someone blocked; adding twice is harmless', async () => {
    const id = await create(ayesha, 'Study buddies', [bilal]);
    const add = (u: TestUser) => t.call('POST', `/v1/chats/groups/${id}/members`, { token: ayesha.token, body: { userIds: [u.id] } });
    expect((await add(outsider)).status).toBe(400);
    expect((await add(pending)).status).toBe(400);
    await t.call('PUT', `/v1/users/${dana.id}/block`, { token: ayesha.token });
    expect((await add(dana)).status).toBe(400);
    expect((await add(bilal)).status).toBe(200); // already in
    expect((await info(ayesha, id)).body.members).toHaveLength(2);
  });

  it('removes a member, who then loses access', async () => {
    const id = await create(ayesha, 'Study buddies', [bilal, cara]);
    expect((await t.call('DELETE', `/v1/chats/groups/${id}/members/${bilal.id}`, { token: ayesha.token })).status).toBe(204);
    expect((await t.call('GET', `/v1/chats/${id}/messages`, { token: bilal.token })).status).toBe(404);
    expect((await list(bilal)).some(c => c.id === id)).toBe(false);
    expect((await t.call('DELETE', `/v1/chats/groups/${id}/members/${bilal.id}`, { token: ayesha.token })).status).toBe(404);
    expect((await t.call('DELETE', `/v1/chats/groups/${id}/members/${ayesha.id}`, { token: ayesha.token })).status).toBe(400); // use leave
  });

  it('promotes and demotes admins, and never leaves a group with none', async () => {
    const id = await create(ayesha, 'Study buddies', [bilal]);
    const demote = (by: TestUser, who: TestUser) => t.call('DELETE', `/v1/chats/groups/${id}/admins/${who.id}`, { token: by.token });
    const lastAdmin = await demote(ayesha, ayesha);
    expect(lastAdmin.status).toBe(409);
    expect(lastAdmin.body.error.code).toBe('last_admin');
    expect((await t.call('PUT', `/v1/chats/groups/${id}/admins/${bilal.id}`, { token: ayesha.token })).status).toBe(200);
    expect((await demote(bilal, ayesha)).status).toBe(200);
    expect((await info(ayesha, id)).body.myRole).toBe('member');
    expect((await demote(ayesha, bilal)).status).toBe(403); // no longer an admin
  });
});

describe('leaving and deleting', () => {
  it('lets anyone leave; the longest-standing member becomes admin when the last admin goes', async () => {
    const id = await create(ayesha, 'Study buddies', [bilal, cara]);
    expect((await t.call('POST', `/v1/chats/groups/${id}/leave`, { token: ayesha.token })).status).toBe(204);
    expect((await t.call('GET', `/v1/chats/${id}/messages`, { token: ayesha.token })).status).toBe(404);
    const g = (await info(bilal, id)).body;
    expect(g.members.map((m: { name: string; role: string }) => `${m.name}:${m.role}`).sort()).toEqual(['Bilal:admin', 'Cara:member']);
  });

  it('removes a group nobody is left in, with its messages', async () => {
    const id = await create(ayesha, 'Solo', []);
    await say(ayesha, id, 'hello?');
    await t.call('POST', `/v1/chats/groups/${id}/leave`, { token: ayesha.token });
    expect((await t.pool.query('SELECT 1 FROM conversations WHERE id = $1', [id])).rowCount).toBe(0);
    expect((await t.pool.query('SELECT 1 FROM messages WHERE conversation_id = $1', [id])).rowCount).toBe(0);
  });

  it('lets an admin delete the whole group for everyone', async () => {
    const id = await create(ayesha, 'Study buddies', [bilal]);
    await say(bilal, id, 'bye');
    expect((await t.call('DELETE', `/v1/chats/groups/${id}`, { token: ayesha.token })).status).toBe(204);
    expect((await info(bilal, id)).status).toBe(404);
    expect((await t.pool.query('SELECT 1 FROM conversation_members WHERE conversation_id = $1', [id])).rowCount).toBe(0);
  });

  it('drops a student from their groups when they leave the university', async () => {
    const id = await create(ayesha, 'Study buddies', [bilal]);
    await t.call('DELETE', '/v1/membership', { token: bilal.token });
    expect((await info(ayesha, id)).body.members.map((m: { name: string }) => m.name)).toEqual(['Ayesha']);
  });
});

describe('lines like "Ayesha added Bilal"', () => {
  it('are written when a group is made, people are added or removed, someone leaves, or it is renamed', async () => {
    const id = await create(ayesha, 'Study buddies', [bilal]);
    expect(await lines(ayesha, id)).toEqual(['Ayesha created this group', 'Ayesha added Bilal']);
    await t.call('POST', `/v1/chats/groups/${id}/members`, { token: ayesha.token, body: { userIds: [cara.id, dana.id] } });
    await t.call('PATCH', `/v1/chats/groups/${id}`, { token: ayesha.token, body: { name: 'Exam crew' } });
    await t.call('DELETE', `/v1/chats/groups/${id}/members/${dana.id}`, { token: ayesha.token });
    await t.call('POST', `/v1/chats/groups/${id}/leave`, { token: bilal.token });
    expect(await lines(ayesha, id)).toEqual([
      'Ayesha created this group',
      'Ayesha added Bilal',
      'Ayesha added Cara, Dana',
      'Ayesha changed the group name to "Exam crew"',
      'Ayesha removed Dana',
      'Bilal left',
    ]);
  });

  it('are not counted as unread messages, but a new member sees how they were added', async () => {
    const id = await create(ayesha, 'Study buddies', [bilal]);
    expect((await list(bilal)).find(c => c.id === id)?.unread).toBe(0);
    await t.call('POST', `/v1/chats/groups/${id}/members`, { token: ayesha.token, body: { userIds: [cara.id] } });
    expect(await lines(cara, id)).toEqual(['Ayesha added Cara']); // nothing from before they joined
    expect((await list(cara)).find(c => c.id === id)?.lastMessage?.body).toBe('added Cara');
  });
});

describe('reporting a message from a group', () => {
  it('works for members only', async () => {
    const id = await create(ayesha, 'Study buddies', [bilal, cara]);
    const sent = (await say(bilal, id, 'rude words')).body;
    expect((await t.call('POST', '/v1/reports', { token: cara.token, body: { targetType: 'message', targetId: sent.id, reason: 'harassment' } })).status).toBe(201);
    expect((await t.call('POST', '/v1/reports', { token: dana.token, body: { targetType: 'message', targetId: sent.id, reason: 'spam' } })).status).toBe(404);
  });
});
