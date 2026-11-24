import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { emptyTrash } from '../src/media/trash.js';
import { createStorage } from '../src/storage/index.js';
import { createCtx, type Ctx, type TestUser } from './helpers.js';

let t: Ctx;
let ayesha: TestUser;
let bilal: TestUser;
let cara: TestUser;
let admin: TestUser;
let outsider: TestUser;
let jpg: Buffer;
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('fake office document body')]);

beforeAll(async () => {
  t = await createCtx();
  jpg = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#10B981' } }).jpeg().toBuffer();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  await t.universe('iac');
  await t.universe('uol');
  ayesha = await t.user({ email: 'ayesha@iac.test', name: 'Ayesha', uni: 'iac' });
  bilal = await t.user({ email: 'bilal@iac.test', name: 'Bilal', uni: 'iac' });
  cara = await t.user({ email: 'cara@iac.test', name: 'Cara', uni: 'iac' });
  admin = await t.user({ email: 'admin@iac.test', name: 'Admin', uni: 'iac', role: 'uni_admin' });
  outsider = await t.user({ email: 'out@uol.test', name: 'Outsider', uni: 'uol' });
});

const dm = async (a: TestUser, b: TestUser) => (await t.call('POST', '/v1/chats/dm', { token: a.token, body: { userId: b.id } })).body.id as string;
const group = async (by: TestUser, members: TestUser[]) => (await t.call('POST', '/v1/chats/groups', { token: by.token, body: { name: 'Study crew', memberIds: members.map(m => m.id) } })).body.id as string;
const send = (u: TestUser, conv: string, name: string, data: Buffer, caption = '', type = 'application/octet-stream') => t.upload(`/v1/chats/${conv}/attachments`, u.token, [{ name, data, type }], caption ? { caption } : {});
const messages = async (u: TestUser, conv: string) => ((await t.call('GET', `/v1/chats/${conv}/messages`, { token: u.token })).body.messages as any[]).filter(m => m.kind === 'text');
const fetchFile = (url: string) => t.app.inject({ method: 'GET', url });

describe('sending a picture', () => {
  it('stores a clean picture with a thumbnail that both people can open', async () => {
    const conv = await dm(ayesha, bilal);
    const r = await send(ayesha, conv, 'holiday.png', jpg, 'look at this', 'image/png');
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ body: 'look at this', mine: true, attachment: { kind: 'image', name: 'holiday.png', mime: 'image/jpeg', width: 120, height: 80 } });
    const seen = (await messages(bilal, conv))[0];
    expect(seen.mine).toBe(false);
    for (const url of [seen.attachment.url, seen.attachment.thumbUrl]) {
      const res = await fetchFile(url);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['content-disposition']).toBeUndefined(); // pictures show, they are not downloads
    }
  });

  it('can be only a picture with no text', async () => {
    const conv = await dm(ayesha, bilal);
    const r = await send(ayesha, conv, 'p.jpg', jpg);
    expect(r.status).toBe(201);
    expect(r.body.body).toBe('');
  });

  it('rejects something that is not a picture or a supported document', async () => {
    const conv = await dm(ayesha, bilal);
    expect((await send(ayesha, conv, 'notes.txt', Buffer.from('just some text'))).status).toBe(400);
    expect((await send(ayesha, conv, 'virus.exe', Buffer.from('MZ\x90\x00 pretend executable'))).status).toBe(400);
    expect((await t.upload(`/v1/chats/${conv}/attachments`, ayesha.token, [], {})).status).toBe(400);
    expect((await messages(ayesha, conv))).toHaveLength(0); // nothing half-saved
  });
});

describe('sending a document', () => {
  it('accepts a PDF and serves it only as a download', async () => {
    const conv = await dm(ayesha, bilal);
    const r = await send(ayesha, conv, 'Lecture 3.pdf', pdf);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.attachment).toMatchObject({ kind: 'file', name: 'Lecture 3.pdf', mime: 'application/pdf', thumbUrl: null });
    const res = await fetchFile(r.body.attachment.url);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.rawPayload.equals(pdf)).toBe(true);
  });

  it('accepts Word, Excel and PowerPoint files, but only when they really are such files', async () => {
    const conv = await dm(ayesha, bilal);
    expect((await send(ayesha, conv, 'report.docx', zip)).body.attachment.mime).toContain('wordprocessingml');
    expect((await send(ayesha, conv, 'budget.xlsx', zip)).body.attachment.mime).toContain('spreadsheetml');
    expect((await send(ayesha, conv, 'slides.pptx', zip)).body.attachment.mime).toContain('presentationml');
    expect((await send(ayesha, conv, 'fake.docx', Buffer.from('not a zip at all'))).status).toBe(400);
    expect((await send(ayesha, conv, 'archive.zip', zip)).status).toBe(400); // plain zips are not documents
    expect((await send(ayesha, conv, 'fake.pdf', Buffer.from('this is not a pdf'))).status).toBe(400);
  });

  it('cleans odd file names', async () => {
    const conv = await dm(ayesha, bilal);
    const r = await send(ayesha, conv, '..\\..\\secret/report<1>:final.pdf', pdf);
    expect(r.body.attachment.name).toBe('report1final.pdf');
  });
});

describe('who can open what', () => {
  it('keeps pictures and documents inside the conversation', async () => {
    const conv = await dm(ayesha, bilal);
    expect((await send(cara, conv, 'x.jpg', jpg)).status).toBe(404); // not in this chat
    expect((await send(outsider, conv, 'x.jpg', jpg)).status).toBe(404);
    expect((await t.call('GET', `/v1/chats/${conv}/messages`, { token: cara.token })).status).toBe(404);
  });

  it('refuses a link that was changed, expired, or used for the wrong kind of file', async () => {
    const conv = await dm(ayesha, bilal);
    const img = (await send(ayesha, conv, 'a.jpg', jpg)).body.attachment;
    const doc = (await send(ayesha, conv, 'a.pdf', pdf)).body.attachment;
    expect((await fetchFile(img.url.replace(/sig=.{3}/, 'sig=AAA'))).statusCode).toBe(404);
    expect((await fetchFile(img.url.replace(/exp=\d+/, 'exp=1000000000000'))).statusCode).toBe(404);
    expect((await fetchFile(img.url.split('?')[0]!)).statusCode).toBe(404); // no signature at all
    expect((await fetchFile(doc.url.replace('/file?', '/full?'))).statusCode).toBe(404); // signature belongs to another variant
  });

  it('follows the rules of a group: only members, and admins-only groups stay quiet for others', async () => {
    const conv = await group(ayesha, [bilal]);
    expect((await send(bilal, conv, 'a.jpg', jpg)).status).toBe(201);
    expect((await send(cara, conv, 'a.jpg', jpg)).status).toBe(404);
    await t.call('PATCH', `/v1/chats/groups/${conv}`, { token: ayesha.token, body: { onlyAdminsPost: true } });
    expect((await send(bilal, conv, 'b.jpg', jpg)).status).toBe(403);
    expect((await send(ayesha, conv, 'c.pdf', pdf)).status).toBe(201);
  });

  it('hides a blocked person’s pictures too', async () => {
    const conv = await group(ayesha, [bilal, cara]);
    await send(bilal, conv, 'a.jpg', jpg, 'hello');
    await t.call('PUT', `/v1/users/${bilal.id}/block`, { token: cara.token });
    expect(await messages(cara, conv)).toHaveLength(0);
    expect(await messages(ayesha, conv)).toHaveLength(1);
  });
});

describe('previews and notifications', () => {
  it('shows "Photo" or the document name in the chat list, and in the push', async () => {
    const conv = await dm(ayesha, bilal);
    t.push.reset();
    await send(ayesha, conv, 'a.jpg', jpg);
    expect(t.push.sent.at(-1)?.message.body).toBe('📷 Photo');
    expect((await t.call('GET', '/v1/chats', { token: bilal.token })).body.chats[0].lastMessage.body).toBe('📷 Photo');
    await send(ayesha, conv, 'Lecture 3.pdf', pdf);
    expect(t.push.sent.at(-1)?.message.body).toBe('📄 Lecture 3.pdf');
    expect((await t.call('GET', '/v1/chats', { token: bilal.token })).body.chats[0].lastMessage.body).toBe('📄 Lecture 3.pdf');
    await send(ayesha, conv, 'b.jpg', jpg, 'with a caption');
    expect((await t.call('GET', '/v1/chats', { token: bilal.token })).body.chats[0].lastMessage.body).toBe('with a caption');
  });
});

describe('files do not outlive their messages', () => {
  const storage = () => createStorage(t.config.uploadsDir);
  const keysOf = async () => (await t.pool.query<{ storage_key: string; thumb_key: string | null }>('SELECT storage_key, thumb_key FROM message_attachments')).rows;

  it('deletes the files when an admin removes a reported message', async () => {
    const conv = await dm(ayesha, bilal);
    const sent = (await send(ayesha, conv, 'bad.jpg', jpg)).body;
    const [k] = await keysOf();
    expect(await storage().open(k!.storage_key)).not.toBeNull();
    expect((await t.call('POST', '/v1/reports', { token: bilal.token, body: { targetType: 'message', targetId: sent.id, reason: 'inappropriate' } })).status).toBe(201);
    const report = (await t.call('GET', '/v1/admin/reports', { token: admin.token })).body.reports[0];
    expect(report.title).toBe('A picture or document');
    expect((await t.call('POST', `/v1/admin/reports/${report.id}`, { token: admin.token, body: { action: 'remove' } })).status).toBe(200);
    expect(await storage().open(k!.storage_key)).toBeNull();
    expect(await storage().open(k!.thumb_key!)).toBeNull();
  });

  it('deletes the files of a deleted group, and of a student who left the university', async () => {
    const conv = await group(ayesha, [bilal]);
    await send(ayesha, conv, 'a.pdf', pdf);
    const [k] = await keysOf();
    await t.call('DELETE', `/v1/chats/groups/${conv}`, { token: ayesha.token });
    expect(await storage().open(k!.storage_key)).toBeNull();

    const conv2 = await dm(cara, bilal);
    await send(cara, conv2, 'b.pdf', pdf);
    const [k2] = await keysOf();
    await t.call('DELETE', '/v1/membership', { token: cara.token });
    expect(await emptyTrash(t.pool, storage())).toBe(1); // nothing triggered the clean-up yet: the trash list still knew
    expect(await storage().open(k2!.storage_key)).toBeNull();
  });
});

describe('reactions', () => {
  const react = (u: TestUser, conv: string, id: string, emoji: string) => t.call('PUT', `/v1/chats/${conv}/messages/${id}/reaction`, { token: u.token, body: { emoji } });
  const first = async (u: TestUser, conv: string) => (await messages(u, conv))[0];

  it('counts reactions per emoji and tells each person which one is theirs', async () => {
    const conv = await group(ayesha, [bilal, cara]);
    const m = (await t.call('POST', `/v1/chats/${conv}/messages`, { token: ayesha.token, body: { body: 'exam is on friday' } })).body;
    expect((await react(bilal, conv, m.id, '👍')).status).toBe(200);
    await react(cara, conv, m.id, '👍');
    await react(ayesha, conv, m.id, '😮');
    const forBilal = (await first(bilal, conv)).reactions;
    expect(forBilal).toEqual([
      { emoji: '👍', count: 2, mine: true },
      { emoji: '😮', count: 1, mine: false },
    ]);
    expect((await first(ayesha, conv)).reactions.find((r: any) => r.mine).emoji).toBe('😮');
  });

  it('changes a reaction instead of adding another, and removes it', async () => {
    const conv = await dm(ayesha, bilal);
    const m = (await t.call('POST', `/v1/chats/${conv}/messages`, { token: ayesha.token, body: { body: 'hi' } })).body;
    await react(bilal, conv, m.id, '👍');
    const changed = await react(bilal, conv, m.id, '❤️');
    expect(changed.body.reactions).toEqual([{ emoji: '❤️', count: 1, mine: true }]);
    const gone = await t.call('DELETE', `/v1/chats/${conv}/messages/${m.id}/reaction`, { token: bilal.token });
    expect(gone.body.reactions).toEqual([]);
  });

  it('only allows the offered emojis, and only on messages you can see', async () => {
    const conv = await dm(ayesha, bilal);
    const other = await dm(ayesha, cara);
    const m = (await t.call('POST', `/v1/chats/${conv}/messages`, { token: ayesha.token, body: { body: 'hi' } })).body;
    expect((await react(bilal, conv, m.id, '🤡')).status).toBe(400);
    expect((await react(bilal, conv, m.id, 'x')).status).toBe(400);
    expect((await react(cara, conv, m.id, '👍')).status).toBe(404); // not in this chat
    expect((await react(outsider, conv, m.id, '👍')).status).toBe(404);
    expect((await react(ayesha, other, m.id, '👍')).status).toBe(404); // message belongs to a different conversation
    await t.call('PUT', `/v1/users/${ayesha.id}/block`, { token: bilal.token });
    expect((await react(bilal, conv, m.id, '👍')).status).toBe(404); // a blocked sender's message is hidden, so it cannot be reacted to
  });

  it('works on pictures too, and goes when the message goes', async () => {
    const conv = await dm(ayesha, bilal);
    const m = (await send(ayesha, conv, 'a.jpg', jpg)).body;
    await react(bilal, conv, m.id, '😂');
    expect((await first(ayesha, conv)).reactions).toEqual([{ emoji: '😂', count: 1, mine: false }]);
    await t.pool.query('DELETE FROM messages WHERE id = $1', [m.id]);
    expect((await t.pool.query('SELECT 1 FROM message_reactions')).rowCount).toBe(0);
  });
});
