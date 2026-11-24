import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createCtx, eventBody, type Ctx, type TestUser } from './helpers.js';

let t: Ctx;
let admin: TestUser;
let ayesha: TestUser;
let bilal: TestUser;
let otherAdmin: TestUser;

beforeAll(async () => {
  t = await createCtx();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  await t.universe('iac');
  await t.universe('uol');
  admin = await t.user({ email: 'admin@iac.test', name: 'Admin', uni: 'iac', role: 'uni_admin' });
  ayesha = await t.user({ email: 'ayesha@iac.test', name: 'Ayesha', uni: 'iac', department: 'Computer Science' });
  bilal = await t.user({ email: 'bilal@iac.test', name: 'Bilal', uni: 'iac', department: 'Business' });
  await t.user({ email: 'pending@iac.test', uni: 'iac', status: 'pending' });
  otherAdmin = await t.user({ email: 'admin@uol.test', uni: 'uol', role: 'uni_admin' });
  await t.user({ email: 'x@uol.test', uni: 'uol' });
});

describe('admin dashboard numbers', () => {
  it('only admins can read them', async () => {
    expect((await t.call('GET', '/v1/admin/stats', { token: ayesha.token })).status).toBe(403);
    expect((await t.call('GET', '/v1/admin/stats')).status).toBe(401);
  });

  it('counts members, events, content and reports for this university only', async () => {
    const ev = (await t.call('POST', '/v1/events', { token: admin.token, body: eventBody({ title: 'Open Day', startsAt: Date.now() - 3_600_000, endsAt: Date.now() + 3_600_000 }) })).body.id;
    const ticket = (await t.call('PUT', `/v1/events/${ev}/rsvp`, { token: ayesha.token, body: { status: 'going' } })).body;
    await t.call('PUT', `/v1/events/${ev}/rsvp`, { token: bilal.token, body: { status: 'going' } });
    const sec = await t.user({ email: 'sec@iac.test', uni: 'iac', role: 'security' });
    await t.call('POST', '/v1/checkin', { token: sec.token, body: { payload: `CH1|T|iac|${ev}|${ayesha.id}|${ticket.code}` } });
    await t.call('POST', '/v1/events', { token: admin.token, body: eventBody({ title: 'Next week' }) });
    const post = await t.call('POST', '/v1/posts', { token: admin.token, body: { kind: 'official', source: 'Registrar', title: 'Welcome', body: 'Welcome to the new semester everyone.' } });
    expect(post.status, JSON.stringify(post.body)).toBe(201);
    await t.call('POST', '/v1/jobs', { token: admin.token, body: { company: 'Acme', title: 'Developer', kind: 'job', applyUrl: 'https://acme.example/jobs' } });
    const g = (await t.call('POST', '/v1/study-groups', { token: ayesha.token, body: { title: 'Exam prep' } })).body;
    await t.call('POST', '/v1/reports', { token: bilal.token, body: { targetType: 'study_group', targetId: g.id, reason: 'spam' } });
    const s = (await t.call('POST', '/v1/societies', { token: admin.token, body: { name: 'Coding Club', category: 'Tech' } })).body;
    await t.call('PUT', `/v1/societies/${s.id}/join`, { token: ayesha.token });

    const r = (await t.call('GET', '/v1/admin/stats', { token: admin.token })).body;
    expect(r.members).toMatchObject({ active: 4, pending: 1, suspended: 0 }); // admin, ayesha, bilal, security
    expect(r.events).toMatchObject({ upcoming: 1, heldLast30Days: 1, ticketsLast30Days: 2, checkedInLast30Days: 1 });
    expect(r.content).toMatchObject({ postsLast30Days: 1, openReports: 1, openJobs: 1, openStudyGroups: 1 });
    expect(r.recentEvents.map((e: any) => e.title)).toEqual(['Next week', 'Open Day']);
    expect(r.recentEvents.find((e: any) => e.title === 'Open Day')).toMatchObject({ going: 2, checkedIn: 1 });
    expect(r.membersByDepartment).toEqual(expect.arrayContaining([{ department: 'Computer Science', count: 3 }, { department: 'Business', count: 1 }]));
    expect(r.topSocieties[0]).toEqual({ name: 'Coding Club', members: 1 });

    // The other university sees none of it.
    const other = (await t.call('GET', '/v1/admin/stats', { token: otherAdmin.token })).body;
    expect(other.members.active).toBe(2);
    expect(other.events).toMatchObject({ upcoming: 0, heldLast30Days: 0 });
    expect(other.content).toMatchObject({ postsLast30Days: 0, openReports: 0, openJobs: 0, openStudyGroups: 0 });
    expect(other.recentEvents).toEqual([]);
  });
});
