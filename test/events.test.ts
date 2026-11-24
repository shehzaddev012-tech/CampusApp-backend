import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runReminders } from '../src/jobs/reminders.js';
import { checkIn } from '../src/modules/events.js';
import { createCtx, eventBody, HOURS, type Ctx, type TestUser } from './helpers.js';

let t: Ctx;
let admin: TestUser;
let society: TestUser;
let security: TestUser;
let ayesha: TestUser;

beforeAll(async () => {
  t = await createCtx();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  await t.universe('iac');
  admin = await t.user({ email: 'admin@iac.test', name: 'Admin', uni: 'iac', role: 'uni_admin' });
  society = await t.user({ email: 'soc@iac.test', name: 'Society', uni: 'iac', role: 'society_head' });
  security = await t.user({ email: 'sec@iac.test', name: 'Security', uni: 'iac', role: 'security' });
  ayesha = await t.user({ email: 'ayesha@iac.test', name: 'Ayesha', uni: 'iac' });
});

const create = async (over: Record<string, unknown> = {}, by: TestUser = society): Promise<string> => {
  const r = await t.call('POST', '/v1/events', { token: by.token, body: eventBody({ societyId: by.societyId, ...over }) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id;
};
const rsvp = (u: TestUser, id: string, status: 'going' | 'interested' = 'going') => t.call('PUT', `/v1/events/${id}/rsvp`, { token: u.token, body: { status } });
const students = (n: number, prefix = 's') => Promise.all(Array.from({ length: n }, (_, i) => t.user({ email: `${prefix}${i}@iac.test`, uni: 'iac' })));
const event = async (id: string) => (await t.call('GET', `/v1/events/${id}`, { token: admin.token })).body;
const qr = (eventId: string, u: TestUser, code: string) => `CH1|T|iac|${eventId}|${u.id}|${code}`;
const scan = (payload: string, who: TestUser = security, eventId?: string) => t.call('POST', '/v1/checkin', { token: who.token, body: { payload, eventId } });

describe('creating events', () => {
  it('only organisers can create', async () => {
    expect((await t.call('POST', '/v1/events', { token: ayesha.token, body: eventBody() })).status).toBe(403);
    expect((await t.call('POST', '/v1/events', { token: security.token, body: eventBody() })).status).toBe(403);
    expect((await t.call('POST', '/v1/events', { token: society.token, body: eventBody({ societyId: society.societyId }) })).status).toBe(201);
    expect((await t.call('POST', '/v1/events', { token: admin.token, body: eventBody() })).status).toBe(201);
  });

  it('validates the fields', async () => {
    const bad = async (over: Record<string, unknown>) => (await t.call('POST', '/v1/events', { token: society.token, body: eventBody({ societyId: society.societyId, ...over }) })).status;
    expect(await bad({ endsAt: Date.now() })).toBe(400); // ends before it starts
    expect(await bad({ endsAt: Date.now() + 20 * 24 * HOURS })).toBe(400); // longer than 7 days
    expect(await bad({ category: 'Astrology' })).toBe(400);
    expect(await bad({ capacity: 0 })).toBe(400);
    expect(await bad({ title: 'ab' })).toBe(400);
  });

  it('saves a schedule and reports it back in order', async () => {
    const start = Date.now() + HOURS;
    const id = await create({
      schedule: [
        { at: start + 3600_000, title: 'Second talk', speaker: 'Dr. B' },
        { at: start, title: 'Opening', speaker: 'Dr. A' },
      ],
    });
    const e = await event(id);
    expect(e.schedule.map((s: { title: string }) => s.title)).toEqual(['Opening', 'Second talk']);
    expect(e.schedule[0].speaker).toBe('Dr. A');
  });

  it('lists recent and upcoming events only', async () => {
    const upcoming = await create({ title: 'Upcoming' });
    const longAgo = await create({ title: 'Long ago', startsAt: Date.now() - 40 * 24 * HOURS, endsAt: Date.now() - 40 * 24 * HOURS + HOURS });
    const list = (await t.call('GET', '/v1/events', { token: ayesha.token })).body.events.map((e: { id: string }) => e.id);
    expect(list).toContain(upcoming);
    expect(list).not.toContain(longAgo);
  });
});

describe('seats', () => {
  it('a ticket has a secret code; asking again returns the same ticket', async () => {
    const id = await create({ capacity: 10 });
    const first = (await rsvp(ayesha, id)).body;
    expect(first.status).toBe('going');
    expect(first.code).toHaveLength(24);
    expect((await rsvp(ayesha, id)).body.code).toBe(first.code);
    expect((await event(id)).goingCount).toBe(1);
  });

  it('"interested" does not use a seat and can become a ticket', async () => {
    const id = await create({ capacity: 1 });
    const other = await t.user({ email: 'o@iac.test', uni: 'iac' });
    expect((await rsvp(ayesha, id, 'interested')).body).toMatchObject({ status: 'interested', code: null });
    expect((await rsvp(other, id)).body.status).toBe('going'); // seat still free
    expect((await rsvp(ayesha, id)).body.status).toBe('waitlist'); // now full
    const e = await event(id);
    expect(e).toMatchObject({ goingCount: 1, waitlistCount: 1, interestedCount: 0 });
  });

  it('an ended event takes no more RSVPs', async () => {
    const id = await create({ startsAt: Date.now() - 3 * HOURS, endsAt: Date.now() - HOURS });
    const r = await rsvp(ayesha, id);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('event_ended');
  });

  it('25 students tapping at the same moment get exactly the seats there are', async () => {
    const id = await create({ capacity: 5 });
    const crowd = await students(25);
    const results = await Promise.all(crowd.map(s => rsvp(s, id)));
    expect(results.every(r => r.status === 200)).toBe(true);

    const going = results.filter(r => r.body.status === 'going');
    const waiting = results.filter(r => r.body.status === 'waitlist');
    expect(going).toHaveLength(5);
    expect(waiting).toHaveLength(20);
    expect(new Set(going.map(r => r.body.code)).size).toBe(5); // every ticket is unique
    expect(await event(id)).toMatchObject({ goingCount: 5, waitlistCount: 20 });
  });

  it('a freed seat goes to the first student in the queue, who is notified', async () => {
    const id = await create({ capacity: 1 });
    const [a, b, c] = await students(3);
    await rsvp(a!, id);
    await rsvp(b!, id);
    await rsvp(c!, id);

    t.push.reset();
    expect((await t.call('DELETE', `/v1/events/${id}/rsvp`, { token: a!.token })).status).toBe(204);

    const bNow = (await t.call('GET', '/v1/events', { token: b!.token })).body.myRsvps[id];
    const cNow = (await t.call('GET', '/v1/events', { token: c!.token })).body.myRsvps[id];
    expect(bNow.status).toBe('going');
    expect(bNow.code).toBeTruthy();
    expect(cNow.status).toBe('waitlist');
    expect(t.push.sent.at(-1)?.userIds).toEqual([b!.id]);
    expect(await event(id)).toMatchObject({ goingCount: 1, waitlistCount: 1 });
  });

  it('leaving the waiting list, or dropping "interested", frees nobody else', async () => {
    const id = await create({ capacity: 1 });
    const [a, b, c] = await students(3);
    await rsvp(a!, id);
    await rsvp(b!, id);
    await rsvp(c!, id, 'interested');
    await t.call('DELETE', `/v1/events/${id}/rsvp`, { token: b!.token });
    await t.call('DELETE', `/v1/events/${id}/rsvp`, { token: c!.token });
    expect(await event(id)).toMatchObject({ goingCount: 1, waitlistCount: 0, interestedCount: 0 });
  });

  it('three people giving up at once promote exactly three from the queue', async () => {
    const id = await create({ capacity: 3 });
    const holders = await students(3, 'h');
    const queue = await students(6, 'q');
    for (const s of holders) {
      await rsvp(s, id);
    }
    for (const s of queue) {
      await rsvp(s, id);
    }
    await Promise.all(holders.map(h => t.call('DELETE', `/v1/events/${id}/rsvp`, { token: h.token })));
    expect(await event(id)).toMatchObject({ goingCount: 3, waitlistCount: 3 });
    // the first three in the queue were promoted, in order
    const statuses = await Promise.all(queue.map(async q => (await t.call('GET', '/v1/events', { token: q.token })).body.myRsvps[id].status));
    expect(statuses).toEqual(['going', 'going', 'going', 'waitlist', 'waitlist', 'waitlist']);
  });

  it('counts volunteers', async () => {
    const id = await create({ volunteersNeeded: 3 });
    await t.call('PUT', `/v1/events/${id}/volunteer`, { token: ayesha.token, body: { volunteer: true } });
    expect((await event(id)).volunteerCount).toBe(1);
    await t.call('PUT', `/v1/events/${id}/volunteer`, { token: ayesha.token, body: { volunteer: false } });
    expect((await event(id)).volunteerCount).toBe(0);
  });
});

describe('the gate', () => {
  let id: string;
  let code: string;
  beforeEach(async () => {
    id = await create({ capacity: 10 });
    code = (await rsvp(ayesha, id)).body.code;
  });

  it('lets a valid ticket in exactly once', async () => {
    const first = await scan(qr(id, ayesha, code), security, id);
    expect(first.body).toMatchObject({ ok: true, kind: 'ticket', name: 'Ayesha' });
    expect((await event(id)).checkedInCount).toBe(1);

    const again = await scan(qr(id, ayesha, code), security, id);
    expect(again.body).toMatchObject({ ok: false, reason: 'already_used', name: 'Ayesha' });
    expect(again.body.detail).toMatch(/Already checked in at \d\d:\d\d/);
    expect((await event(id)).checkedInCount).toBe(1);
  });

  it('accepts the short code printed under the QR, once, and only with an event picked', async () => {
    const short = `${code.slice(0, 4)}-${code.slice(4, 8)}`.toUpperCase();
    expect((await scan(short, security)).body).toMatchObject({ ok: false, reason: 'invalid' }); // no event picked
    expect((await scan('ZZZZ-ZZZZ', security, id)).body).toMatchObject({ ok: false, reason: 'not_valid' });
    expect((await scan(short, security, id)).body).toMatchObject({ ok: true, kind: 'ticket', name: 'Ayesha' });
    expect((await scan(short, security, id)).body).toMatchObject({ ok: false, reason: 'already_used' });
    expect((await event(id)).checkedInCount).toBe(1);
  });

  it('twenty scanners reading the same ticket at once admit one person, not twenty', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => scan(qr(id, ayesha, code))));
    expect(results.filter(r => r.body.ok === true)).toHaveLength(1);
    expect(results.filter(r => r.body.reason === 'already_used')).toHaveLength(19);
    expect((await event(id)).checkedInCount).toBe(1);
  });

  it('refuses forged, wrong-event and malformed codes', async () => {
    expect((await scan(qr(id, ayesha, 'forged-secret-0000000000'))).body).toMatchObject({ ok: false, reason: 'not_valid' });
    expect((await scan('hello')).body).toMatchObject({ ok: false, reason: 'invalid' });
    const otherEvent = await create({ title: 'Other' });
    expect((await scan(qr(id, ayesha, code), security, otherEvent)).body).toMatchObject({ ok: false, reason: 'wrong_event' });
    expect((await event(id)).checkedInCount).toBe(0);
  });

  it('refuses a ticket whose seat was given up', async () => {
    await t.call('DELETE', `/v1/events/${id}/rsvp`, { token: ayesha.token });
    expect((await scan(qr(id, ayesha, code))).body).toMatchObject({ ok: false, reason: 'not_valid' });
  });

  it('a waitlisted student has no ticket to scan', async () => {
    const small = await create({ capacity: 1 });
    const [first, second] = await students(2);
    await rsvp(first!, small);
    await rsvp(second!, small);
    expect((await scan(qr(small, second!, 'anything-anything-anything'))).body.ok).toBe(false);
  });

  it('only gate staff can scan', async () => {
    expect((await scan(qr(id, ayesha, code), ayesha)).status).toBe(403);
  });

  it('is closed before it opens and after it ends', async () => {
    const early = await create({ startsAt: Date.now() + 10 * 24 * HOURS, endsAt: Date.now() + 10 * 24 * HOURS + HOURS });
    const c = (await rsvp(ayesha, early)).body.code;
    expect((await scan(qr(early, ayesha, c))).body).toMatchObject({ ok: false, reason: 'closed' });

    // the same ticket, three hours after the event finished
    const later = new Date(Date.now() + 10 * 24 * HOURS + 4 * HOURS);
    const r = await checkIn(t.pool, 'iac', qr(early, ayesha, c), early, later);
    expect(r).toMatchObject({ ok: false, reason: 'closed' });
    // but during the event it works
    const during = new Date(Date.now() + 10 * 24 * HOURS + 0.5 * HOURS);
    expect((await checkIn(t.pool, 'iac', qr(early, ayesha, c), early, during)).ok).toBe(true);
  });
});

describe('guest passes', () => {
  let id: string;
  beforeEach(async () => {
    id = await create({ capacity: 10 });
  });
  const request = (u: TestUser, name = 'Guest One') => t.call('POST', `/v1/events/${id}/guest-passes`, { token: u.token, body: { guestName: name, guestPhone: '0300 1234567' } });

  it('needs a ticket for the event first', async () => {
    const r = await request(ayesha);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('ticket_required');
  });

  it('allows two guests, even when requested at the same moment', async () => {
    await rsvp(ayesha, id);
    const results = await Promise.all([1, 2, 3, 4, 5].map(i => request(ayesha, `Guest ${i}`)));
    expect(results.filter(r => r.status === 201)).toHaveLength(2);
    expect(results.filter(r => r.body?.error?.code === 'guest_limit')).toHaveLength(3);
    expect((await t.call('GET', '/v1/guest-passes', { token: ayesha.token })).body.passes).toHaveLength(2);
  });

  it('a rejected pass does not count against the limit', async () => {
    await rsvp(ayesha, id);
    const a = (await request(ayesha, 'A guest')).body;
    await request(ayesha, 'B guest');
    expect((await request(ayesha, 'C guest')).status).toBe(409);
    await t.call('PATCH', `/v1/guest-passes/${a.id}`, { token: society.token, body: { approve: false } });
    expect((await request(ayesha, 'C guest')).status).toBe(201);
  });

  it('only the host sees the secret code; staff see the queue without it', async () => {
    await rsvp(ayesha, id);
    const pass = (await request(ayesha)).body;
    expect(pass.code).toHaveLength(24);

    const queue = await t.call('GET', '/v1/guest-passes/pending', { token: security.token });
    expect(queue.body.passes).toHaveLength(1);
    expect(queue.body.passes[0].code).toBe('');
    expect((await t.call('GET', '/v1/guest-passes/pending', { token: ayesha.token })).status).toBe(403);
  });

  it('organisers decide; security and students cannot; a pass is decided once', async () => {
    await rsvp(ayesha, id);
    const pass = (await request(ayesha)).body;
    const decide = (u: TestUser, approve: boolean) => t.call('PATCH', `/v1/guest-passes/${pass.id}`, { token: u.token, body: { approve } });
    expect((await decide(security, true)).status).toBe(403);
    expect((await decide(ayesha, true)).status).toBe(403);
    expect((await decide(society, true)).body.status).toBe('approved');
    expect((await decide(society, false)).body.error.code).toBe('already_decided');
    expect(t.push.sent.some(s => s.userIds.includes(ayesha.id) && /approved/i.test(s.message.title))).toBe(true);
  });

  it('at the gate: pending is refused, approved gets in once, and the head count includes guests', async () => {
    const code = (await rsvp(ayesha, id)).body.code;
    const pass = (await request(ayesha)).body;
    const payload = `CH1|G|iac|${id}|${pass.id}|${pass.code}`;

    expect((await scan(payload)).body).toMatchObject({ ok: false, reason: 'pending' });
    await t.call('PATCH', `/v1/guest-passes/${pass.id}`, { token: society.token, body: { approve: true } });

    const results = await Promise.all([1, 2, 3, 4, 5].map(() => scan(payload)));
    expect(results.filter(r => r.body.ok === true)).toHaveLength(1);
    expect(results.find(r => r.body.ok === true)?.body).toMatchObject({ kind: 'guest', name: 'Guest One', detail: 'Guest of Ayesha' });

    await scan(qr(id, ayesha, code));
    expect((await event(id)).checkedInCount).toBe(2); // the student and the guest
  });

  it('a forged guest code is refused', async () => {
    await rsvp(ayesha, id);
    const pass = (await request(ayesha)).body;
    await t.call('PATCH', `/v1/guest-passes/${pass.id}`, { token: society.token, body: { approve: true } });
    expect((await scan(`CH1|G|iac|${id}|${pass.id}|forged-secret-0000000000`)).body).toMatchObject({ ok: false, reason: 'not_valid' });
  });

  it('validates the guest details', async () => {
    await rsvp(ayesha, id);
    expect((await t.call('POST', `/v1/events/${id}/guest-passes`, { token: ayesha.token, body: { guestName: 'A', guestPhone: '0300' } })).status).toBe(400);
  });
});

describe('feedback', () => {
  it('only after the event, only with a ticket, rating 1 to 5', async () => {
    const id = await create({ capacity: 10 });
    await rsvp(ayesha, id);
    expect((await t.call('PUT', `/v1/events/${id}/feedback`, { token: ayesha.token, body: { rating: 5 } })).body.error.code).toBe('event_not_over');

    // an event that finished two hours ago (inserted directly: the API will not take bookings for it)
    const past = (await t.pool.query<{ id: string }>(
      `INSERT INTO events (university_id, title, organizer, category, blurb, venue, starts_at, ends_at)
       VALUES ('iac', 'Past event', 'Org', 'Tech', 'A finished event for the tests.', 'Hall', now() - interval '4 hours', now() - interval '2 hours') RETURNING id`,
    )).rows[0]!.id;
    expect((await t.call('PUT', `/v1/events/${past}/feedback`, { token: ayesha.token, body: { rating: 4 } })).body.error.code).toBe('no_ticket');

    await t.pool.query("INSERT INTO rsvps (event_id, user_id, student_name, status, code) VALUES ($1, $2, 'Ayesha', 'going', 'abcdefghijklmnopqrstuvwx')", [past, ayesha.id]);
    expect((await t.call('PUT', `/v1/events/${past}/feedback`, { token: ayesha.token, body: { rating: 6 } })).status).toBe(400);
    const ok = await t.call('PUT', `/v1/events/${past}/feedback`, { token: ayesha.token, body: { rating: 4, comment: 'Great' } });
    expect(ok.body).toMatchObject({ rating: 4, feedback: 'Great' });
  });
});

describe('reminders', () => {
  it('tell ticket holders once, one hour before', async () => {
    const soon = await create({ startsAt: Date.now() + HOURS, endsAt: Date.now() + 3 * HOURS, title: 'Starts soon' });
    const far = await create({ startsAt: Date.now() + 5 * HOURS, endsAt: Date.now() + 7 * HOURS, title: 'Starts later' });
    await rsvp(ayesha, soon);
    await rsvp(ayesha, far);
    const other = await t.user({ email: 'nobody@iac.test', uni: 'iac' });
    await rsvp(other, soon, 'interested'); // interested, not going: not reminded

    t.push.reset();
    expect(await runReminders(t.pool, t.push)).toBe(1);
    expect(t.push.sent).toHaveLength(1);
    expect(t.push.sent[0]?.userIds).toEqual([ayesha.id]);
    expect(t.push.sent[0]?.message.body).toMatch(/Starts soon starts in about an hour/);

    expect(await runReminders(t.pool, t.push)).toBe(0); // not sent twice
    expect(t.push.sent).toHaveLength(1);
  });

  it('also remind a day ahead', async () => {
    const tomorrow = await create({ startsAt: Date.now() + 24 * HOURS, endsAt: Date.now() + 26 * HOURS });
    await rsvp(ayesha, tomorrow);
    t.push.reset();
    expect(await runReminders(t.pool, t.push)).toBe(1);
    expect(t.push.sent[0]?.message.body).toMatch(/is tomorrow/);
  });
});

describe('the database itself refuses impossible states', () => {
  it('rejects them even if the API had a bug', async () => {
    const id = await create();
    const insert = (sql: string, params: unknown[]) => t.pool.query(sql, params);
    // a "going" ticket must have a code
    await expect(insert("INSERT INTO rsvps (event_id, user_id, student_name, status) VALUES ($1, $2, 'x', 'going')", [id, ayesha.id])).rejects.toThrow();
    // only a going ticket may have a code
    await expect(insert("INSERT INTO rsvps (event_id, user_id, student_name, status, code) VALUES ($1, $2, 'x', 'interested', 'abc')", [id, ayesha.id])).rejects.toThrow();
    // cannot be checked in without a ticket
    await expect(insert("INSERT INTO rsvps (event_id, user_id, student_name, status, checked_in_at) VALUES ($1, $2, 'x', 'interested', now())", [id, ayesha.id])).rejects.toThrow();
    // an event cannot end before it starts
    await expect(insert("INSERT INTO events (university_id, title, organizer, category, blurb, venue, starts_at, ends_at) VALUES ('iac', 'Bad', 'o', 'Tech', 'A valid description here', 'v', now(), now() - interval '1 hour')", [])).rejects.toThrow();
    // two tickets can never share a code
    await insert("INSERT INTO rsvps (event_id, user_id, student_name, status, code) VALUES ($1, $2, 'a', 'going', 'samecodesamecodesamecode1')", [id, ayesha.id]);
    await expect(insert("INSERT INTO rsvps (event_id, user_id, student_name, status, code) VALUES ($1, $2, 'b', 'going', 'samecodesamecodesamecode1')", [id, admin.id])).rejects.toThrow();
  });
});
