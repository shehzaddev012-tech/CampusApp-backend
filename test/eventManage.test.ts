import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createCtx, eventBody, HOURS, type Ctx, type TestUser } from './helpers.js';

let t: Ctx;
let admin: TestUser;
let otherAdmin: TestUser;
let head: TestUser;
let otherHead: TestUser;
let ayesha: TestUser;

beforeAll(async () => {
  t = await createCtx();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  await t.universe('iac');
  await t.universe('uol');
  admin = await t.user({ email: 'admin@iac.test', uni: 'iac', role: 'uni_admin' });
  otherAdmin = await t.user({ email: 'admin@uol.test', uni: 'uol', role: 'uni_admin' });
  head = await t.user({ email: 'head@iac.test', uni: 'iac', role: 'society_head' });
  otherHead = await t.user({ email: 'head2@iac.test', uni: 'iac', role: 'society_head' });
  ayesha = await t.user({ email: 'ayesha@iac.test', name: 'Ayesha', uni: 'iac' });
});

const make = async (by: TestUser = head, over: Record<string, unknown> = {}): Promise<string> => {
  const r = await t.call('POST', '/v1/events', { token: by.token, body: eventBody({ societyId: by.societyId, ...over }) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id;
};

describe('editing an event', () => {
  it('lets the society head and an admin edit, and nobody else', async () => {
    const id = await make();
    const edit = (u: TestUser) => t.call('PATCH', `/v1/events/${id}`, { token: u.token, body: { title: 'Renamed event', venue: 'Auditorium' } });
    expect((await edit(head)).status).toBe(200);
    expect((await edit(admin)).status).toBe(200);
    expect((await edit(otherHead)).status).toBe(403); // heads another society
    expect((await edit(ayesha)).status).toBe(403); // a student
    expect((await edit(otherAdmin)).status).toBe(404); // another university cannot even see it
    const e = (await t.call('GET', `/v1/events/${id}`, { token: ayesha.token })).body;
    expect(e.title).toBe('Renamed event');
    expect(e.venue).toBe('Auditorium');
  });

  it('keeps the dates sensible and does not shrink below the tickets already given', async () => {
    const id = await make(head, { capacity: 10 });
    await t.call('PUT', `/v1/events/${id}/rsvp`, { token: ayesha.token, body: { status: 'going' } });
    const bad = (body: Record<string, unknown>) => t.call('PATCH', `/v1/events/${id}`, { token: head.token, body });
    expect((await bad({ endsAt: Date.now() })).status).toBe(400);
    expect((await bad({ endsAt: Date.now() + 30 * 24 * HOURS })).status).toBe(400);
    expect((await bad({ capacity: 0 })).status).toBe(400);
    expect((await bad({ capacity: 1 })).status).toBe(200); // exactly the one ticket given
    const second = await t.user({ email: 'second@iac.test', uni: 'iac' });
    await t.call('PUT', `/v1/events/${id}/rsvp`, { token: second.token, body: { status: 'going' } }); // waitlist now
    expect((await bad({ capacity: null })).status).toBe(200); // removing the limit is fine
  });
});

describe('cancelling an event', () => {
  it('deletes it, with its tickets, and tells the students who were going', async () => {
    const id = await make();
    await t.call('PUT', `/v1/events/${id}/rsvp`, { token: ayesha.token, body: { status: 'going' } });
    t.push.reset();
    expect((await t.call('DELETE', `/v1/events/${id}`, { token: otherHead.token })).status).toBe(403);
    expect((await t.call('DELETE', `/v1/events/${id}`, { token: head.token })).status).toBe(204);
    expect((await t.call('GET', `/v1/events/${id}`, { token: ayesha.token })).status).toBe(404);
    expect((await t.pool.query('SELECT 1 FROM rsvps WHERE event_id = $1', [id])).rowCount).toBe(0);
    const sent = t.push.sent.filter(s => s.userIds.includes(ayesha.id));
    expect(sent.some(s => s.message.title === 'Event cancelled')).toBe(true);
  });

  it('cannot delete another university’s event', async () => {
    const id = await make();
    expect((await t.call('DELETE', `/v1/events/${id}`, { token: otherAdmin.token })).status).toBe(404);
    expect((await t.call('GET', `/v1/events/${id}`, { token: admin.token })).status).toBe(200);
  });
});

describe('attendees', () => {
  it('shows names and check-in state to organisers only, never ticket codes', async () => {
    const id = await make();
    await t.call('PUT', `/v1/events/${id}/rsvp`, { token: ayesha.token, body: { status: 'going' } });
    const list = await t.call('GET', `/v1/events/${id}/attendees`, { token: head.token });
    expect(list.status).toBe(200);
    expect(list.body.attendees).toHaveLength(1);
    expect(list.body.attendees[0]).toMatchObject({ name: 'Ayesha', status: 'going', checkedInAt: null });
    expect(JSON.stringify(list.body)).not.toContain('code');
    expect((await t.call('GET', `/v1/events/${id}/attendees`, { token: ayesha.token })).status).toBe(403);
    expect((await t.call('GET', `/v1/events/${id}/attendees`, { token: otherHead.token })).status).toBe(403);
    expect((await t.call('GET', `/v1/events/${id}/attendees`, { token: otherAdmin.token })).status).toBe(404);
  });
});
