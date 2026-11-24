import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createCtx, type Ctx, type TestUser } from './helpers.js';

let t: Ctx;
let admin: TestUser;
let bizStudent: TestUser;
let society: TestUser;
let security: TestUser;
let ayesha: TestUser;
let bilal: TestUser;

beforeAll(async () => {
  t = await createCtx();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  await t.universe('iac', ['Computer Science', 'Business']);
  admin = await t.user({ email: 'admin@iac.test', name: 'Admin', uni: 'iac', role: 'uni_admin' });
  bizStudent = await t.user({ email: 'biz@iac.test', name: 'Biz Student', uni: 'iac', department: 'Business' });
  society = await t.user({ email: 'soc@iac.test', name: 'Society Head', uni: 'iac', role: 'society_head' });
  security = await t.user({ email: 'sec@iac.test', name: 'Security', uni: 'iac', role: 'security' });
  ayesha = await t.user({ email: 'ayesha@iac.test', name: 'Ayesha', uni: 'iac', department: 'Computer Science' });
  bilal = await t.user({ email: 'bilal@iac.test', name: 'Bilal', uni: 'iac', department: 'Business' });
});

const body = (over: Record<string, unknown> = {}) => ({
  kind: 'official',
  title: 'Mid-term schedule',
  body: 'Exams start on Monday. Check your department channel.',
  source: 'Examination Office',
  // A society update always names its society (the test society head's own).
  ...(over.kind === 'society' ? { societyId: society.societyId } : {}),
  ...over,
});
const publish = (u: TestUser, over: Record<string, unknown> = {}) => t.call('POST', '/v1/posts', { token: u.token, body: body(over) });

describe('who can publish what', () => {
  it.each([
    ['uni_admin', () => admin, ['official', 'society', 'alert']],
    ['society_head', () => society, ['society']],
    ['security', () => security, ['alert']],
    ['student', () => ayesha, []],
  ] as const)('%s', async (_role, who, allowed) => {
    for (const kind of ['official', 'society', 'alert']) {
      const r = await publish(who(), { kind });
      expect(r.status, `${_role} publishing ${kind}`).toBe((allowed as readonly string[]).includes(kind) ? 201 : 403);
    }
  });

  it('only admins can pin, and never an alert', async () => {
    expect((await publish(admin, { pinned: true })).body.pinned).toBe(true);
    expect((await publish(society, { kind: 'society', pinned: true })).status).toBe(403);
    expect((await publish(admin, { kind: 'alert', pinned: true })).status).toBe(403);
  });

  it('validates title, body and department channel', async () => {
    expect((await publish(admin, { title: 'ab' })).status).toBe(400);
    expect((await publish(admin, { body: 'too short' })).status).toBe(400);
    expect((await publish(admin, { channel: 'Astrology' })).status).toBe(400);
    expect((await publish(admin, { channel: 'Business' })).status).toBe(201);
  });
});

describe('who gets notified', () => {
  it('everyone except the author for a university-wide update', async () => {
    await publish(admin);
    const sent = t.push.sent.at(-1);
    expect(sent?.userIds.sort()).toEqual([bizStudent.id, society.id, security.id, ayesha.id, bilal.id].sort());
    expect(sent?.userIds).not.toContain(admin.id);
  });

  it('only that department for a channel update', async () => {
    await publish(admin, { channel: 'Business' });
    expect(t.push.sent.at(-1)?.userIds.sort()).toEqual([bizStudent.id, bilal.id].sort());
  });

  it('alerts are urgent', async () => {
    await publish(security, { kind: 'alert', title: 'Fire drill' });
    const sent = t.push.sent.at(-1);
    expect(sent?.message.urgent).toBe(true);
    expect(sent?.message.title).toBe('Alert: Fire drill');
  });
});

describe('reading, liking, saving and commenting', () => {
  let postId: string;
  beforeEach(async () => {
    postId = (await publish(admin)).body.id;
  });

  it('lists newest first with counts and my own like/save state', async () => {
    await t.call('PUT', `/v1/posts/${postId}/like`, { token: ayesha.token });
    await t.call('PUT', `/v1/posts/${postId}/bookmark`, { token: ayesha.token });
    await publish(admin, { title: 'A newer update' });

    const mine = await t.call('GET', '/v1/posts', { token: ayesha.token });
    expect(mine.body.posts[0].title).toBe('A newer update');
    const old = mine.body.posts.find((p: { id: string }) => p.id === postId);
    expect(old.likeCount).toBe(1);
    expect(mine.body.state).toEqual({ liked: [postId], bookmarked: [postId] });

    // Another student sees the count but not my state.
    const theirs = await t.call('GET', '/v1/posts', { token: bilal.token });
    expect(theirs.body.posts.find((p: { id: string }) => p.id === postId).likeCount).toBe(1);
    expect(theirs.body.state).toEqual({ liked: [], bookmarked: [] });
  });

  it('liking twice counts once, and unliking works', async () => {
    await t.call('PUT', `/v1/posts/${postId}/like`, { token: ayesha.token });
    const twice = await t.call('PUT', `/v1/posts/${postId}/like`, { token: ayesha.token });
    expect(twice.body.likeCount).toBe(1);
    const off = await t.call('DELETE', `/v1/posts/${postId}/like`, { token: ayesha.token });
    expect(off.body.likeCount).toBe(0);
  });

  it('many simultaneous likes from different students are all counted', async () => {
    const students = await Promise.all(Array.from({ length: 12 }, (_, i) => t.user({ email: `s${i}@iac.test`, uni: 'iac' })));
    await Promise.all(students.map(s => t.call('PUT', `/v1/posts/${postId}/like`, { token: s.token })));
    const list = await t.call('GET', '/v1/posts', { token: admin.token });
    expect(list.body.posts.find((p: { id: string }) => p.id === postId).likeCount).toBe(12);
  });

  it('"seen by" counts each student once', async () => {
    await t.call('POST', `/v1/posts/${postId}/read`, { token: ayesha.token });
    await t.call('POST', `/v1/posts/${postId}/read`, { token: ayesha.token });
    await t.call('POST', `/v1/posts/${postId}/read`, { token: bilal.token });
    const list = await t.call('GET', '/v1/posts', { token: admin.token });
    expect(list.body.posts[0].readCount).toBe(2);
  });

  it('comments are listed in order, validated, and counted', async () => {
    await t.call('POST', `/v1/posts/${postId}/comments`, { token: ayesha.token, body: { text: 'First' } });
    await t.call('POST', `/v1/posts/${postId}/comments`, { token: bilal.token, body: { text: 'Second' } });
    expect((await t.call('POST', `/v1/posts/${postId}/comments`, { token: bilal.token, body: { text: '   ' } })).status).toBe(400);
    expect((await t.call('POST', `/v1/posts/${postId}/comments`, { token: bilal.token, body: { text: 'x'.repeat(501) } })).status).toBe(400);

    const c = await t.call('GET', `/v1/posts/${postId}/comments`, { token: admin.token });
    expect(c.body.comments.map((x: { text: string }) => x.text)).toEqual(['First', 'Second']);
    expect(c.body.comments[0].authorName).toBe('Ayesha');
    const list = await t.call('GET', '/v1/posts', { token: admin.token });
    expect(list.body.posts[0].commentCount).toBe(2);
  });

  it('only the author or an admin can delete a comment or a post', async () => {
    const c = (await t.call('POST', `/v1/posts/${postId}/comments`, { token: ayesha.token, body: { text: 'mine' } })).body;
    expect((await t.call('DELETE', `/v1/posts/${postId}/comments/${c.id}`, { token: bilal.token })).status).toBe(403);
    expect((await t.call('DELETE', `/v1/posts/${postId}/comments/${c.id}`, { token: ayesha.token })).status).toBe(204);

    expect((await t.call('DELETE', `/v1/posts/${postId}`, { token: ayesha.token })).status).toBe(403);
    expect((await t.call('DELETE', `/v1/posts/${postId}`, { token: admin.token })).status).toBe(204);
    expect((await t.call('GET', `/v1/posts/${postId}/comments`, { token: admin.token })).status).toBe(404);
  });

  it('a malformed id is a 404, not a server error', async () => {
    expect((await t.call('PUT', '/v1/posts/not-a-uuid/like', { token: ayesha.token })).status).toBe(404);
  });
});
