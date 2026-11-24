import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createCtx, eventBody, type Ctx, type TestUser } from './helpers.js';

let t: Ctx;
let admin: TestUser;
let ayesha: TestUser;
let bilal: TestUser;
let outsider: TestUser;

beforeAll(async () => {
  t = await createCtx();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  await t.universe('iac', ['Computer Science', 'Business']);
  await t.universe('uol');
  admin = await t.user({ email: 'admin@iac.test', uni: 'iac', role: 'uni_admin' });
  ayesha = await t.user({ email: 'ayesha@iac.test', uni: 'iac' });
  bilal = await t.user({ email: 'bilal@iac.test', uni: 'iac', department: 'Business' });
  outsider = await t.user({ email: 'out@uol.test', uni: 'uol' });
});

const post = (over: Record<string, unknown> = {}) =>
  t.call('POST', '/v1/posts', { token: admin.token, body: { kind: 'official', title: 'Exam datesheet', body: 'The datesheet is now on the portal.', source: 'Exam Office', ...over } });
const inbox = (u: TestUser) => t.call('GET', '/v1/notifications', { token: u.token });

describe('notification inbox', () => {
  it('a new update lands in every member inbox (and nobody elsewhere)', async () => {
    const p = (await post()).body;
    const mine = (await inbox(ayesha)).body;
    expect(mine.unread).toBe(1);
    expect(mine.notifications[0]).toMatchObject({ title: 'Exam datesheet', kind: 'official', postId: p.id, read: false });
    expect((await inbox(bilal)).body.unread).toBe(1);
    expect((await inbox(admin)).body.unread).toBe(0); // the author is not notified
    expect((await inbox(outsider)).body.unread).toBe(0); // another university
  });

  it('a department update only reaches that department', async () => {
    await post({ channel: 'Business' });
    expect((await inbox(bilal)).body.unread).toBe(1);
    expect((await inbox(ayesha)).body.unread).toBe(0);
  });

  it('alerts are marked as alerts', async () => {
    await post({ kind: 'alert', title: 'Heavy rain' });
    expect((await inbox(ayesha)).body.notifications[0]).toMatchObject({ kind: 'alert', title: 'Alert: Heavy rain' });
  });

  it('can be read one at a time or all together, only by their owner', async () => {
    await post({ title: 'One' });
    await post({ title: 'Two' });
    const list = (await inbox(ayesha)).body;
    expect(list.unread).toBe(2);
    expect(list.notifications.map((n: { title: string }) => n.title)).toEqual(['Two', 'One']); // newest first

    // someone else cannot mark mine as read
    await t.call('POST', `/v1/notifications/${list.notifications[0].id}/read`, { token: bilal.token });
    expect((await inbox(ayesha)).body.unread).toBe(2);

    await t.call('POST', `/v1/notifications/${list.notifications[0].id}/read`, { token: ayesha.token });
    expect((await inbox(ayesha)).body.unread).toBe(1);
    await t.call('POST', '/v1/notifications/read-all', { token: ayesha.token });
    expect((await inbox(ayesha)).body.unread).toBe(0);
    expect((await inbox(bilal)).body.unread).toBe(2); // untouched
  });

  it('works without any push delivery (the inbox is the source of truth)', async () => {
    await post();
    t.push.reset();
    expect((await inbox(ayesha)).body.notifications).toHaveLength(1);
  });

  it('events: a freed seat and an approved guest pass notify the right person', async () => {
    const society = await t.user({ email: 'soc@iac.test', uni: 'iac', role: 'society_head' });
    const ev = (await t.call('POST', '/v1/events', { token: society.token, body: eventBody({ capacity: 1, title: 'Tiny event', societyId: society.societyId }) })).body.id;
    await t.call('PUT', `/v1/events/${ev}/rsvp`, { token: ayesha.token, body: { status: 'going' } });
    await t.call('PUT', `/v1/events/${ev}/rsvp`, { token: bilal.token, body: { status: 'going' } });
    await t.call('DELETE', `/v1/events/${ev}/rsvp`, { token: ayesha.token });
    const n = (await inbox(bilal)).body.notifications[0];
    expect(n).toMatchObject({ title: 'A seat opened up', eventId: ev, read: false });

    // an approved guest pass tells the host
    await t.call('PUT', `/v1/events/${ev}/rsvp`, { token: ayesha.token, body: { status: 'interested' } });
    const pass = (await t.call('POST', `/v1/events/${ev}/guest-passes`, { token: bilal.token, body: { guestName: 'Visitor One', guestPhone: '03001234567' } })).body;
    await t.call('PATCH', `/v1/guest-passes/${pass.id}`, { token: society.token, body: { approve: true } });
    expect((await inbox(bilal)).body.notifications[0].title).toBe('Guest pass approved');
  });

  it('deleting a post removes its notifications', async () => {
    const p = (await post()).body;
    await t.call('DELETE', `/v1/posts/${p.id}`, { token: admin.token });
    expect((await inbox(ayesha)).body.notifications).toHaveLength(0);
  });

  it('requires sign-in', async () => {
    expect((await t.call('GET', '/v1/notifications')).status).toBe(401);
  });
});
