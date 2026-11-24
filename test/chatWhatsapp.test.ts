import WebSocket from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createCtx, type Ctx, type TestUser } from './helpers.js';

let t: Ctx;
let port: number;
let ayesha: TestUser;
let bilal: TestUser;
let cara: TestUser;
let outsider: TestUser;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  t = await createCtx();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  port = (t.app.server.address() as { port: number }).port;
});
afterAll(async () => {
  sockets.forEach(s => s.terminate());
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  await t.universe('iac');
  await t.universe('uol');
  ayesha = await t.user({ email: 'ayesha@iac.test', name: 'Ayesha', uni: 'iac' });
  bilal = await t.user({ email: 'bilal@iac.test', name: 'Bilal', uni: 'iac' });
  cara = await t.user({ email: 'cara@iac.test', name: 'Cara', uni: 'iac' });
  outsider = await t.user({ email: 'out@uol.test', name: 'Outsider', uni: 'uol' });
});

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const dm = async (a: TestUser, b: TestUser) => (await t.call('POST', '/v1/chats/dm', { token: a.token, body: { userId: b.id } })).body.id as string;
const group = async (by: TestUser, members: TestUser[]) => (await t.call('POST', '/v1/chats/groups', { token: by.token, body: { name: 'Study crew', memberIds: members.map(m => m.id) } })).body.id as string;
const say = (u: TestUser, conv: string, body: string, replyTo?: string) => t.call('POST', `/v1/chats/${conv}/messages`, { token: u.token, body: { body, ...(replyTo ? { replyTo } : {}) } });
const thread = async (u: TestUser, conv: string) => (await t.call('GET', `/v1/chats/${conv}/messages`, { token: u.token })).body as { messages: any[]; receipts: { deliveredAt: number; readAt: number } | null };
const texts = async (u: TestUser, conv: string) => (await thread(u, conv)).messages.filter(m => m.kind === 'text');

function connect(token: string): Promise<{ ws: WebSocket; got: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
    sockets.push(ws);
    const got: any[] = [];
    ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('message', d => {
      const msg = JSON.parse(d.toString());
      got.push(msg);
      if (msg.type === 'ready') {
        resolve({ ws, got });
      }
    });
  });
}

describe('replying to a message', () => {
  it('quotes the message it answers', async () => {
    const conv = await dm(ayesha, bilal);
    const first = (await say(ayesha, conv, 'Which room is the exam in?')).body;
    const reply = await say(bilal, conv, 'Room 12', first.id);
    expect(reply.status).toBe(201);
    expect(reply.body.replyTo).toEqual({ id: first.id, senderName: 'Ayesha', body: 'Which room is the exam in?', attachmentKind: null, deleted: false });
    expect((await texts(ayesha, conv))[1].replyTo.senderName).toBe('Ayesha');
  });

  it('only quotes a message of the same chat', async () => {
    const conv = await dm(ayesha, bilal);
    const other = await dm(ayesha, cara);
    const elsewhere = (await say(ayesha, other, 'private to Cara')).body;
    expect((await say(bilal, conv, 'sneaky', elsewhere.id)).status).toBe(400);
    expect((await say(bilal, conv, 'sneaky', '00000000-0000-4000-8000-000000000000')).status).toBe(400);
  });

  it('shows a deleted message as deleted inside the quote', async () => {
    const conv = await dm(ayesha, bilal);
    const first = (await say(ayesha, conv, 'oops wrong chat')).body;
    await say(bilal, conv, 'what?', first.id);
    await t.call('DELETE', `/v1/chats/${conv}/messages/${first.id}?for=everyone`, { token: ayesha.token });
    expect((await texts(bilal, conv))[1].replyTo).toMatchObject({ body: '', deleted: true });
  });
});

describe('deleting a message', () => {
  it('"for me" hides it only from me', async () => {
    const conv = await dm(ayesha, bilal);
    const m = (await say(ayesha, conv, 'embarrassing')).body;
    expect((await t.call('DELETE', `/v1/chats/${conv}/messages/${m.id}?for=me`, { token: bilal.token })).status).toBe(204);
    expect(await texts(bilal, conv)).toHaveLength(0);
    expect(await texts(ayesha, conv)).toHaveLength(1);
    expect((await t.call('GET', '/v1/chats', { token: bilal.token })).body.chats.find((c: any) => c.id === conv)?.lastMessage ?? null).toBeNull();
  });

  it('"for everyone" leaves a placeholder, removes the content, and only the sender may do it', async () => {
    const conv = await dm(ayesha, bilal);
    const m = (await say(ayesha, conv, 'wrong person')).body;
    expect((await t.call('DELETE', `/v1/chats/${conv}/messages/${m.id}?for=everyone`, { token: bilal.token })).status).toBe(403);
    expect((await t.call('DELETE', `/v1/chats/${conv}/messages/${m.id}?for=everyone`, { token: outsider.token })).status).toBe(404);
    expect((await t.call('DELETE', `/v1/chats/${conv}/messages/${m.id}?for=everyone`, { token: ayesha.token })).status).toBe(204);
    const seen = (await texts(bilal, conv))[0];
    expect(seen).toMatchObject({ deleted: true, body: '', attachment: null, reactions: [] });
    expect((await t.call('GET', '/v1/chats', { token: bilal.token })).body.chats[0].lastMessage.body).toBe('🚫 This message was deleted');
  });

  it('cannot delete for everyone after two days, and deleting a picture removes its file', async () => {
    const conv = await dm(ayesha, bilal);
    const old = (await say(ayesha, conv, 'ancient')).body;
    await t.pool.query("UPDATE messages SET created_at = now() - interval '3 days' WHERE id = $1", [old.id]);
    const late = await t.call('DELETE', `/v1/chats/${conv}/messages/${old.id}?for=everyone`, { token: ayesha.token });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('too_late');
    expect((await t.call('DELETE', `/v1/chats/${conv}/messages/${old.id}?for=me`, { token: ayesha.token })).status).toBe(204); // for me is always possible
  });
});

describe('ticks', () => {
  it('goes from sent, to delivered when the other phone fetches, to read', async () => {
    const conv = await dm(ayesha, bilal);
    const sent = (await say(ayesha, conv, 'hello')).body;
    let r = (await thread(ayesha, conv)).receipts!;
    expect(r.deliveredAt).toBeLessThan(sent.createdAt); // only sent
    await thread(bilal, conv); // Bilal's phone receives it
    r = (await thread(ayesha, conv)).receipts!;
    expect(r.deliveredAt).toBeGreaterThanOrEqual(sent.createdAt);
    expect(r.readAt).toBeLessThan(sent.createdAt); // delivered, not read
    await new Promise(res => setTimeout(res, 20));
    await t.call('POST', `/v1/chats/${conv}/read`, { token: bilal.token });
    r = (await thread(ayesha, conv)).receipts!;
    expect(r.readAt).toBeGreaterThanOrEqual(sent.createdAt);
  });

  it('in a group, needs everybody (blue ticks only when all have read)', async () => {
    const conv = await group(ayesha, [bilal, cara]);
    const sent = (await say(ayesha, conv, 'meeting at 4')).body;
    await t.call('POST', `/v1/chats/${conv}/read`, { token: bilal.token });
    expect((await thread(ayesha, conv)).receipts!.readAt).toBeLessThan(sent.createdAt); // Cara has not read it
    await t.call('POST', `/v1/chats/${conv}/read`, { token: cara.token });
    expect((await thread(ayesha, conv)).receipts!.readAt).toBeGreaterThanOrEqual(sent.createdAt);
  });

  it('shows no ticks in big society rooms', async () => {
    const s = (await t.pool.query<{ id: string }>("INSERT INTO societies (university_id, name, about, category) VALUES ('iac', 'Chess', '', 'Social') RETURNING id")).rows[0]!.id;
    await t.call('PUT', `/v1/societies/${s}/join`, { token: ayesha.token });
    const conv = (await t.call('GET', `/v1/chats/society/${s}`, { token: ayesha.token })).body.id;
    expect((await thread(ayesha, conv)).receipts).toBeNull();
  });

  it('tells the sender live (once) when the other phone receives or reads, with no endless echo', async () => {
    const conv = await dm(ayesha, bilal);
    const a = await connect(ayesha.token);
    await say(ayesha, conv, 'hello');
    a.got.length = 0;
    await thread(bilal, conv); // delivered
    await pause(150);
    expect(a.got.filter(m => m.type === 'chat')).toHaveLength(1);
    await thread(bilal, conv); // nothing new to receive: no second nudge
    await thread(ayesha, conv);
    await pause(150);
    expect(a.got.filter(m => m.type === 'chat')).toHaveLength(1);
  });
});

describe('typing and last seen', () => {
  it('shows who is typing to the other people in the chat only', async () => {
    const conv = await group(ayesha, [bilal]);
    const b = await connect(bilal.token);
    const c = await connect(cara.token);
    const a = await connect(ayesha.token);
    a.ws.send(JSON.stringify({ type: 'typing', conversationId: conv }));
    await pause(200);
    expect(b.got.filter(m => m.type === 'typing')).toEqual([{ type: 'typing', conversationId: conv, name: 'Ayesha' }]);
    expect(c.got.filter(m => m.type === 'typing')).toEqual([]); // not in the group
    expect(a.got.filter(m => m.type === 'typing')).toEqual([]); // not echoed
  });

  it('ignores typing in a chat you are not in, and slows down floods', async () => {
    const conv = await dm(ayesha, bilal);
    const b = await connect(bilal.token);
    const c = await connect(cara.token);
    c.ws.send(JSON.stringify({ type: 'typing', conversationId: conv }));
    await pause(150);
    expect(b.got.filter(m => m.type === 'typing')).toEqual([]);
    const a = await connect(ayesha.token);
    for (let i = 0; i < 5; i++) {
      a.ws.send(JSON.stringify({ type: 'typing', conversationId: conv }));
    }
    await pause(200);
    expect(b.got.filter(m => m.type === 'typing')).toHaveLength(1);
  });

  it('reports online, then the last time they were seen', async () => {
    const presence = async (viewer: TestUser, who: TestUser) => t.call('GET', `/v1/users/${who.id}/presence`, { token: viewer.token });
    expect((await presence(ayesha, bilal)).body).toEqual({ online: false, lastSeenAt: null });
    const b = await connect(bilal.token);
    expect((await presence(ayesha, bilal)).body).toEqual({ online: true, lastSeenAt: null });
    b.ws.close();
    await pause(300);
    const after = (await presence(ayesha, bilal)).body;
    expect(after.online).toBe(false);
    expect(Math.abs(after.lastSeenAt - Date.now())).toBeLessThan(5000);
  });

  it('keeps presence inside the university and away from people who blocked each other', async () => {
    expect((await t.call('GET', `/v1/users/${outsider.id}/presence`, { token: ayesha.token })).status).toBe(404);
    await t.call('PUT', `/v1/users/${bilal.id}/block`, { token: ayesha.token });
    expect((await t.call('GET', `/v1/users/${bilal.id}/presence`, { token: ayesha.token })).status).toBe(404);
    expect((await t.call('GET', `/v1/users/${ayesha.id}/presence`, { token: bilal.token })).status).toBe(404);
  });
});
