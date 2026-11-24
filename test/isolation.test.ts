import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createCtx, eventBody, type Ctx, type TestUser } from './helpers.js';

/**
 * The most important promise of CampusHub: a student at one university can never see or touch
 * another university's data, no matter which ids they send.
 */
let t: Ctx;
let adminA: TestUser;
let studentA: TestUser;
let adminB: TestUser;
let studentB: TestUser;
let postA: string;
let eventA: string;
let postB: string;
let eventB: string;

beforeAll(async () => {
  t = await createCtx();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  await t.universe('iac');
  await t.universe('uol');
  adminA = await t.user({ email: 'admin@iac.test', uni: 'iac', role: 'uni_admin' });
  studentA = await t.user({ email: 'stu@iac.test', uni: 'iac' });
  adminB = await t.user({ email: 'admin@uol.test', uni: 'uol', role: 'uni_admin' });
  studentB = await t.user({ email: 'stu@uol.test', uni: 'uol' });

  const post = { kind: 'official', title: 'Private notice', body: 'Only for this university.', source: 'Office' };
  postA = (await t.call('POST', '/v1/posts', { token: adminA.token, body: post })).body.id;
  postB = (await t.call('POST', '/v1/posts', { token: adminB.token, body: { ...post, title: 'Other notice' } })).body.id;
  eventA = (await t.call('POST', '/v1/events', { token: adminA.token, body: eventBody({ title: 'IAC Fest' }) })).body.id;
  eventB = (await t.call('POST', '/v1/events', { token: adminB.token, body: eventBody({ title: 'UOL Fest' }) })).body.id;
});

describe('lists only show my own university', () => {
  it('posts', async () => {
    const a = (await t.call('GET', '/v1/posts', { token: studentA.token })).body.posts;
    const b = (await t.call('GET', '/v1/posts', { token: studentB.token })).body.posts;
    expect(a.map((p: { id: string }) => p.id)).toEqual([postA]);
    expect(b.map((p: { id: string }) => p.id)).toEqual([postB]);
  });

  it('events', async () => {
    const a = (await t.call('GET', '/v1/events', { token: studentA.token })).body.events;
    expect(a.map((e: { title: string }) => e.title)).toEqual(['IAC Fest']);
  });

  it('members (admin list)', async () => {
    const a = (await t.call('GET', '/v1/admin/members', { token: adminA.token })).body.members;
    expect(a.map((m: { email: string }) => m.email).sort()).toEqual(['admin@iac.test', 'stu@iac.test']);
  });
});

describe("another university's ids look like they do not exist", () => {
  it('posts: read, like, bookmark, comment, delete', async () => {
    for (const [method, path, body] of [
      ['GET', `/v1/posts/${postB}/comments`],
      ['PUT', `/v1/posts/${postB}/like`],
      ['PUT', `/v1/posts/${postB}/bookmark`],
      ['POST', `/v1/posts/${postB}/read`],
      ['POST', `/v1/posts/${postB}/comments`, { text: 'hello' }],
      ['DELETE', `/v1/posts/${postB}`],
    ] as const) {
      const r = await t.call(method, path, { token: studentA.token, body });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    // and nothing changed
    const list = await t.call('GET', '/v1/posts', { token: studentB.token });
    expect(list.body.posts[0].likeCount).toBe(0);
  });

  it('events: read, rsvp, volunteer, guest pass', async () => {
    for (const [method, path, body] of [
      ['GET', `/v1/events/${eventB}`],
      ['PUT', `/v1/events/${eventB}/rsvp`, { status: 'going' }],
      ['PUT', `/v1/events/${eventB}/volunteer`, { volunteer: true }],
      ['POST', `/v1/events/${eventB}/guest-passes`, { guestName: 'Guest', guestPhone: '03001234567' }],
      ['DELETE', `/v1/events/${eventB}/rsvp`],
    ] as const) {
      const r = await t.call(method, path, { token: studentA.token, body });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
  });

  it('an admin cannot approve, change or even see a member of another university', async () => {
    expect((await t.call('PATCH', `/v1/admin/members/${studentB.id}`, { token: adminA.token, body: { role: 'uni_admin' } })).status).toBe(404);
    const stillStudent = await t.pool.query("SELECT role FROM memberships WHERE user_id = $1", [studentB.id]);
    expect(stillStudent.rows[0].role).toBe('student');
  });

  it('a ticket from one university is refused by the gate of another', async () => {
    const ticket = (await t.call('PUT', `/v1/events/${eventA}/rsvp`, { token: studentA.token, body: { status: 'going' } })).body;
    const payload = `CH1|T|iac|${eventA}|${studentA.id}|${ticket.code}`;
    const security = await t.user({ email: 'sec@uol.test', uni: 'uol', role: 'security' });
    const r = await t.call('POST', '/v1/checkin', { token: security.token, body: { payload } });
    expect(r.body).toMatchObject({ ok: false, reason: 'wrong_event' });
  });
});

describe('nobody else ever sees my ticket secret', () => {
  it('rsvp codes are only returned to their owner', async () => {
    const mine = (await t.call('PUT', `/v1/events/${eventA}/rsvp`, { token: studentA.token, body: { status: 'going' } })).body;
    expect(mine.code).toBeTruthy();

    const other = await t.user({ email: 'other@iac.test', uni: 'iac' });
    const view = await t.call('GET', '/v1/events', { token: other.token });
    expect(view.body.myRsvps).toEqual({});
    expect(JSON.stringify(view.body)).not.toContain(mine.code);
    const admin = await t.call('GET', '/v1/events', { token: adminA.token });
    expect(JSON.stringify(admin.body)).not.toContain(mine.code);
  });
});
