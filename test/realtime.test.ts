import WebSocket from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createCtx, type Ctx, type TestUser } from './helpers.js';

let t: Ctx;
let port: number;
let ayesha: TestUser;
let bilal: TestUser;
let dana: TestUser;
let pending: TestUser;
let outsider: TestUser;
const open: WebSocket[] = [];

beforeAll(async () => {
  t = await createCtx();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  port = (t.app.server.address() as { port: number }).port;
});
afterAll(async () => {
  open.forEach(s => s.terminate());
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  await t.universe('iac');
  await t.universe('uol');
  ayesha = await t.user({ email: 'ayesha@iac.test', name: 'Ayesha', uni: 'iac' });
  bilal = await t.user({ email: 'bilal@iac.test', name: 'Bilal', uni: 'iac' });
  dana = await t.user({ email: 'dana@iac.test', name: 'Dana', uni: 'iac' });
  pending = await t.user({ email: 'pending@iac.test', name: 'Pending', uni: 'iac', status: 'pending' });
  outsider = await t.user({ email: 'out@uol.test', name: 'Outsider', uni: 'uol' });
});

/** Connects and signs in. Collects everything the server sends. */
function connect(token: string | null, wait = true): Promise<{ ws: WebSocket; got: any[]; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
    open.push(ws);
    const got: any[] = [];
    const closed = new Promise<number>(r => ws.on('close', code => r(code)));
    ws.on('error', reject);
    ws.on('message', d => {
      const msg = JSON.parse(d.toString());
      got.push(msg);
      if (msg.type === 'ready' && wait) {
        resolve({ ws, got, closed });
      }
    });
    ws.on('open', () => {
      if (token !== null) {
        ws.send(JSON.stringify({ type: 'auth', token }));
      }
      if (!wait) {
        resolve({ ws, got, closed });
      }
    });
  });
}
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const dm = async (a: TestUser, b: TestUser): Promise<string> => (await t.call('POST', '/v1/chats/dm', { token: a.token, body: { userId: b.id } })).body.id;
const send = (u: TestUser, conv: string, body: string) => t.call('POST', `/v1/chats/${conv}/messages`, { token: u.token, body: { body } });

describe('signing in on the live connection', () => {
  it('answers ready for an active member', async () => {
    const c = await connect(ayesha.token);
    expect(c.got[0]).toEqual({ type: 'ready' });
  });

  it('closes for a wrong token, for someone not approved, and for a first message that is not auth', async () => {
    expect(await (await connect('not-a-token', false)).closed).toBe(4401);
    expect(await (await connect(pending.token, false)).closed).toBe(4403);
    const c = await connect(null, false);
    c.ws.send(JSON.stringify({ type: 'hello' }));
    expect(await c.closed).toBe(4401);
  });

  it('allows a few connections per person, not unlimited', async () => {
    for (let i = 0; i < 5; i++) {
      await connect(ayesha.token);
    }
    const sixth = await connect(ayesha.token, false);
    expect(await sixth.closed).toBe(4429);
  });
});

describe('nudges', () => {
  it('tells the other person in a chat, with no message text in it', async () => {
    const conv = await dm(ayesha, bilal);
    const b = await connect(bilal.token);
    const a = await connect(ayesha.token);
    expect((await send(ayesha, conv, 'secret hello')).status).toBe(201);
    await pause(150);
    expect(b.got.filter(m => m.type === 'chat')).toEqual([{ type: 'chat', conversationId: conv }]);
    expect(JSON.stringify(b.got)).not.toContain('secret');
    expect(a.got.filter(m => m.type === 'chat')).toEqual([]); // not echoed to the sender
  });

  it('does not reach people outside the chat or the university', async () => {
    const conv = await dm(ayesha, bilal);
    const d = await connect(dana.token);
    const o = await connect(outsider.token);
    await send(ayesha, conv, 'hi');
    await pause(150);
    expect(d.got.filter(m => m.type === 'chat')).toEqual([]);
    expect(o.got.filter(m => m.type === 'chat')).toEqual([]);
  });

  it('reaches every member of a society room except the sender', async () => {
    const s = (await t.pool.query<{ id: string }>("INSERT INTO societies (university_id, name, about, category) VALUES ('iac', 'Chess Club', '', 'Social') RETURNING id")).rows[0]!.id;
    for (const u of [ayesha, bilal]) {
      await t.call('PUT', `/v1/societies/${s}/join`, { token: u.token });
    }
    const conv = (await t.call('GET', `/v1/chats/society/${s}`, { token: ayesha.token })).body.id;
    const a = await connect(ayesha.token);
    const b = await connect(bilal.token);
    const d = await connect(dana.token); // not a member
    await send(ayesha, conv, 'welcome all');
    await pause(150);
    expect(b.got.some(m => m.type === 'chat' && m.conversationId === conv)).toBe(true);
    expect(a.got.some(m => m.type === 'chat')).toBe(false);
    expect(d.got.some(m => m.type === 'chat')).toBe(false);
  });

  it('forgets a connection when it closes', async () => {
    const c = await connect(ayesha.token);
    c.ws.close();
    await c.closed;
    await pause(50);
    const conv = await dm(bilal, ayesha);
    expect((await send(bilal, conv, 'anyone there?')).status).toBe(201); // no error when the person is not connected
  });
});
