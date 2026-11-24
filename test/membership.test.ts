import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createCtx, type Ctx, type TestUser } from './helpers.js';

let t: Ctx;
let admin: TestUser;
let newcomer: TestUser;

beforeAll(async () => {
  t = await createCtx();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  await t.universe('iac', ['Computer Science', 'Business']);
  await t.universe('uol', ['Computer Science']);
  admin = await t.user({ email: 'admin@iac.test', uni: 'iac', role: 'uni_admin' });
  newcomer = await t.user({ email: 'new@iac.test' });
});

const join = (token: string, over: Record<string, unknown> = {}) =>
  t.call('POST', '/v1/membership', { token, body: { universityId: 'iac', studentId: 'IAC-FA22-BCS-104', department: 'Computer Science', ...over } });

describe('joining a university', () => {
  it('lists universities publicly with departments and student counts', async () => {
    const r = await t.call('GET', '/v1/universities');
    expect(r.status).toBe(200);
    const iac = r.body.universities.find((u: { id: string }) => u.id === 'iac');
    expect(iac.departments).toEqual(['Business', 'Computer Science']);
    expect(iac.studentCount).toBe(1);
  });

  it('a new member gets in straight away, with no admin approval', async () => {
    expect((await join(newcomer.token)).body.status).toBe('active');
    const me = await t.call('GET', '/v1/me', { token: newcomer.token });
    expect(me.body.membership.status).toBe('active');
    expect(me.body.membership.studentId).toBe('IAC-FA22-BCS-104');
    expect((await t.call('GET', '/v1/posts', { token: newcomer.token })).status).toBe(200);
    expect((await t.call('GET', '/v1/events', { token: newcomer.token })).status).toBe(200);
  });

  it('only a student ID in the IAC format is accepted (IAC-FA22-BCS-021), in any letter case', async () => {
    for (const bad of ['22-CS-104', 'FA22-BCS-021', 'IAC-FA22-BCS', 'IAC-FA2-BCS-021', 'IAC-FA22-B-021', 'IAC-FA22-BCS-1', 'IAC FA22 BCS 021', '']) {
      const r = await join(newcomer.token, { studentId: bad });
      expect(r.status, bad).toBe(400);
    }
    const ok = await join(newcomer.token, { studentId: ' iac-sp23-bar-007 ' });
    expect(ok.status).toBe(201);
    expect((await t.call('GET', '/v1/me', { token: newcomer.token })).body.membership.studentId).toBe('IAC-SP23-BAR-007');
  });

  it('an admin can still suspend someone, and a suspended student is locked out', async () => {
    await join(newcomer.token);
    await t.call('PATCH', `/v1/admin/members/${newcomer.id}`, { token: admin.token, body: { status: 'suspended' } });
    expect((await t.call('GET', '/v1/posts', { token: newcomer.token })).status).toBe(403);
  });

  it('one student ID can be claimed only once per university', async () => {
    await join(newcomer.token);
    const other = await t.user({ email: 'other@iac.test' });
    const dup = await join(other.token, { studentId: 'iac-fa22-bcs-104' }); // different case, same ID
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('student_id_taken');
  });

  it('rejects unknown universities and unknown departments', async () => {
    expect((await join(newcomer.token, { universityId: 'nowhere' })).status).toBe(404);
    expect((await join(newcomer.token, { department: 'Astrology' })).body.error.code).toBe('unknown_department');
  });

  it('cannot join twice, but can leave and join elsewhere', async () => {
    await join(newcomer.token);
    expect((await join(newcomer.token)).body.error.code).toBe('already_member');
    expect((await t.call('DELETE', '/v1/membership', { token: newcomer.token })).status).toBe(204);
    expect((await join(newcomer.token, { universityId: 'uol', studentId: 'IAC-FA23-BCS-002' })).status).toBe(201);
  });

  it('deleting the account removes the person and their data', async () => {
    await join(newcomer.token);
    expect((await t.call('DELETE', '/v1/me', { token: newcomer.token })).status).toBe(204);
    expect((await t.call('GET', '/v1/me', { token: newcomer.token })).status).toBe(401);
    const left = await t.pool.query('SELECT count(*)::int AS n FROM memberships WHERE user_id = $1', [newcomer.id]);
    expect(left.rows[0].n).toBe(0);
  });
});

describe('who may manage members', () => {
  beforeEach(async () => {
    await join(newcomer.token);
  });

  it('students cannot use the admin endpoints', async () => {
    const student = await t.user({ email: 's@iac.test', uni: 'iac' });
    expect((await t.call('GET', '/v1/admin/members', { token: student.token })).status).toBe(403);
    expect((await t.call('PATCH', `/v1/admin/members/${newcomer.id}`, { token: student.token, body: { status: 'active' } })).status).toBe(403);
  });

  it('only an admin can change roles', async () => {
    const dept = await t.user({ email: 'cs@iac.test', uni: 'iac', role: 'society_head' });
    expect((await t.call('PATCH', `/v1/admin/members/${newcomer.id}`, { token: dept.token, body: { role: 'uni_admin' } })).status).toBe(403);
    const ok = await t.call('PATCH', `/v1/admin/members/${newcomer.id}`, { token: admin.token, body: { role: 'society_head', status: 'active' } });
    expect(ok.body.role).toBe('society_head');
  });

  it('nobody can change their own membership (no self-promotion)', async () => {
    const r = await t.call('PATCH', `/v1/admin/members/${admin.id}`, { token: admin.token, body: { role: 'student' } });
    expect(r.status).toBe(403);
  });

  it('an empty change is rejected', async () => {
    expect((await t.call('PATCH', `/v1/admin/members/${newcomer.id}`, { token: admin.token, body: {} })).status).toBe(400);
  });
});
