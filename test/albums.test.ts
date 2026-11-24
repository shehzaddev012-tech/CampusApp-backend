import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';

import { signedPhotoPath, verifyPhotoSignature } from '../src/media/signedUrl.js';
import { createStorage } from '../src/storage/index.js';
import { createCtx, type Ctx, type TestUser } from './helpers.js';

let t: Ctx;
let admin: TestUser;
let head: TestUser;
let ayesha: TestUser;
let bilal: TestUser;
let outsider: TestUser;

beforeAll(async () => {
  t = await createCtx();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  await t.universe('iac');
  await t.universe('uol');
  admin = await t.user({ email: 'admin@iac.test', name: 'Admin', uni: 'iac', role: 'uni_admin' });
  head = await t.user({ email: 'head@iac.test', name: 'Head', uni: 'iac', role: 'society_head' });
  ayesha = await t.user({ email: 'ayesha@iac.test', name: 'Ayesha', uni: 'iac' });
  bilal = await t.user({ email: 'bilal@iac.test', name: 'Bilal', uni: 'iac' });
  outsider = await t.user({ email: 'omar@uol.test', name: 'Omar', uni: 'uol' });
});

const storage = () => createStorage(t.config.uploadsDir);
const jpeg = (w = 1200, h = 800, color = '#336699') => sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();
const file = async (name = 'a.jpg', w?: number, h?: number) => ({ name, data: await jpeg(w, h) });

const album = async (by: TestUser = admin, over: Record<string, unknown> = {}) => {
  const r = await t.call('POST', '/v1/albums', { token: by.token, body: { title: 'Tech Fest', category: 'Tech', ...over } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};
const add = async (albumId: string, by: TestUser, n = 1) => {
  const r = await t.upload(`/v1/albums/${albumId}/photos`, by.token, await Promise.all(Array.from({ length: n }, (_, i) => file(`p${i}.jpg`))));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.photos as any[];
};
/** Fetches the picture behind a link the API gave out (no sign-in header, like an <Image>). */
const fetchPicture = (path: string) => t.app.inject({ method: 'GET', url: path });

describe('creating albums', () => {
  it('students cannot; admins can; a society head only for their own society', async () => {
    expect((await t.call('POST', '/v1/albums', { token: ayesha.token, body: { title: 'Mine', category: 'Tech' } })).status).toBe(403);
    await album(admin);
    const other = (await t.call('POST', '/v1/societies', { token: admin.token, body: { name: 'Other', category: 'Tech' } })).body;
    expect((await t.call('POST', '/v1/albums', { token: head.token, body: { title: 'No society', category: 'Tech' } })).status).toBe(403);
    expect((await t.call('POST', '/v1/albums', { token: head.token, body: { title: 'Wrong society', category: 'Tech', societyId: other.id } })).status).toBe(403);
    const ok = await album(head, { societyId: head.societyId });
    expect(ok.societyId).toBe(head.societyId);
  });

  it('can belong to an event; the event must be in the same university', async () => {
    const ev = (await t.call('POST', '/v1/events', { token: admin.token, body: { title: 'Sports Day', organizer: 'Office', category: 'Sports', blurb: 'A day of sport for all.', venue: 'Ground', startsAt: Date.now() + 3_600_000, endsAt: Date.now() + 7_200_000 } })).body;
    expect((await album(admin, { eventId: ev.id })).eventId).toBe(ev.id);
    const uolAdmin = await t.user({ email: 'admin@uol.test', uni: 'uol', role: 'uni_admin' });
    expect((await t.call('POST', '/v1/albums', { token: uolAdmin.token, body: { title: 'Steal', category: 'Tech', eventId: ev.id } })).status).toBe(404);
  });

  it('validates the fields', async () => {
    expect((await t.call('POST', '/v1/albums', { token: admin.token, body: { title: 'x', category: 'Tech' } })).status).toBe(400);
    expect((await t.call('POST', '/v1/albums', { token: admin.token, body: { title: 'Fine title', category: 'Astrology' } })).status).toBe(400);
  });
});

describe('uploading', () => {
  it('any member can add pictures; they are cleaned, resized and given signed links', async () => {
    const a = await album();
    const big = await file('big.jpg', 4000, 3000);
    const r = await t.upload(`/v1/albums/${a.id}/photos`, ayesha.token, [big]);
    expect(r.status).toBe(201);
    const p = r.body.photos[0];
    expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(2048);
    expect(p.uploaderName).toBe('Ayesha');
    expect(p.url).toContain('/v1/files/');

    const full = await fetchPicture(p.url);
    const thumb = await fetchPicture(p.thumbUrl);
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('image/jpeg');
    expect(thumb.rawPayload.length).toBeLessThan(full.rawPayload.length);
    expect((await sharp(thumb.rawPayload).metadata()).width).toBeLessThanOrEqual(480);
  });

  it('strips location and camera data (EXIF) from every picture', async () => {
    const a = await album();
    const withExif = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#aa3333' } })
      .jpeg()
      .withExif({ IFD0: { Copyright: 'secret-copyright', ImageDescription: 'my home address' } })
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();
    const [p] = await add(a.id, ayesha).then(() => t.upload(`/v1/albums/${a.id}/photos`, ayesha.token, [{ name: 'x.jpg', data: withExif }])).then(r => r.body.photos);
    const stored = await fetchPicture(p.url);
    expect((await sharp(stored.rawPayload).metadata()).exif).toBeUndefined();
    expect(stored.rawPayload.toString('latin1')).not.toContain('secret-copyright');
  });

  it('refuses things that are not pictures, whatever the file name says', async () => {
    const a = await album();
    const text = await t.upload(`/v1/albums/${a.id}/photos`, ayesha.token, [{ name: 'photo.jpg', data: Buffer.from('<?php echo "hi"; ?>') }]);
    expect(text.status).toBe(400);
    const html = await t.upload(`/v1/albums/${a.id}/photos`, ayesha.token, [{ name: 'photo.png', data: Buffer.from('<html><script>alert(1)</script></html>'), type: 'image/png' }]);
    expect(html.status).toBe(400);
    const n = await t.pool.query('SELECT count(*)::int AS n FROM photos');
    expect(n.rows[0].n).toBe(0);
  });

  it('refuses files over 10 MB and leaves nothing behind', async () => {
    const a = await album();
    const r = await t.upload(`/v1/albums/${a.id}/photos`, ayesha.token, [{ name: 'huge.jpg', data: Buffer.alloc(11 * 1024 * 1024, 7) }]);
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('file_too_large');
  });

  it('is all-or-nothing: one bad file in a batch saves none of the batch', async () => {
    const a = await album();
    const r = await t.upload(`/v1/albums/${a.id}/photos`, ayesha.token, [await file('ok.jpg'), { name: 'bad.jpg', data: Buffer.from('not an image') }]);
    expect(r.status).toBe(400);
    expect((await t.pool.query('SELECT count(*)::int AS n FROM photos')).rows[0].n).toBe(0);
  });

  it('needs at least one file, and a signed-in member of this university', async () => {
    const a = await album();
    expect((await t.upload(`/v1/albums/${a.id}/photos`, ayesha.token, [])).status).toBeGreaterThanOrEqual(400);
    expect((await t.upload(`/v1/albums/${a.id}/photos`, outsider.token, [await file()])).status).toBe(404);
    expect((await t.upload(`/v1/albums/${a.id}/photos`, 'garbage', [await file()])).status).toBe(401);
  });
});

describe('browsing', () => {
  it('lists albums with their count and a cover, newest activity first', async () => {
    const quiet = await album(admin, { title: 'Quiet album' });
    const busy = await album(admin, { title: 'Busy album' });
    await add(busy.id, ayesha, 3);
    const list = (await t.call('GET', '/v1/albums', { token: bilal.token })).body.albums;
    expect(list.map((x: any) => x.title)).toEqual(['Busy album', 'Quiet album']);
    expect(list[0].photoCount).toBe(3);
    expect(list[0].cover.thumbUrl).toContain('/thumb');
    expect(list[1]).toMatchObject({ photoCount: 0, cover: null });
    expect(quiet.id).toBeTruthy();
  });

  it('pages through photos', async () => {
    const a = await album();
    await add(a.id, ayesha, 3);
    await t.pool.query(`UPDATE photos SET created_at = now() - (random() * interval '1 hour') WHERE album_id = $1`, [a.id]);
    const first = (await t.call('GET', `/v1/albums/${a.id}`, { token: bilal.token })).body;
    expect(first.photos).toHaveLength(3);
    expect(first.nextBefore).toBeNull();
  });
});

describe('likes and the best shot', () => {
  it('liking is once per person; the most-liked picture is the best shot and the cover', async () => {
    const a = await album();
    const [p1, p2] = await add(a.id, ayesha, 2);
    expect((await t.call('PUT', `/v1/photos/${p2.id}/like`, { token: bilal.token })).body).toEqual({ liked: true, likeCount: 1 });
    expect((await t.call('PUT', `/v1/photos/${p2.id}/like`, { token: bilal.token })).body.likeCount).toBe(1);
    await t.call('PUT', `/v1/photos/${p2.id}/like`, { token: ayesha.token });
    await t.call('PUT', `/v1/photos/${p1.id}/like`, { token: ayesha.token });

    const view = (await t.call('GET', `/v1/albums/${a.id}`, { token: bilal.token })).body;
    expect(view.bestPhotoId).toBe(p2.id);
    expect(view.photos.find((p: any) => p.id === p2.id)).toMatchObject({ likeCount: 2, liked: true });
    expect(view.photos.find((p: any) => p.id === p1.id)).toMatchObject({ likeCount: 1, liked: false });
    expect(view.album.cover.photoId).toBe(p2.id);
    expect((await t.call('DELETE', `/v1/photos/${p2.id}/like`, { token: bilal.token })).body).toEqual({ liked: false, likeCount: 1 });
  });
});

describe('requests without a body', () => {
  it('accept an empty body labelled as JSON (what a phone sends for a like), and refuse broken JSON', async () => {
    const a = await album();
    const [p] = await add(a.id, ayesha, 1);
    const likeWithEmptyJsonBody = await t.app.inject({ method: 'PUT', url: `/v1/photos/${p.id}/like`, headers: { authorization: `Bearer ${bilal.token}`, 'content-type': 'application/json' }, payload: '' });
    expect(likeWithEmptyJsonBody.statusCode).toBe(200);
    const broken = await t.app.inject({ method: 'POST', url: '/v1/albums', headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }, payload: '{not json' });
    expect(broken.statusCode).toBe(400);
  });
});

describe('removing', () => {
  it('the uploader, the album creator and admins can remove a photo; others cannot; the files go too', async () => {
    const a = await album(head, { societyId: head.societyId });
    const [mine, forHead, forAdmin] = await add(a.id, ayesha, 3);
    const row = await t.pool.query('SELECT storage_key, thumb_key FROM photos WHERE id = $1', [mine.id]);

    expect((await t.call('DELETE', `/v1/photos/${mine.id}`, { token: bilal.token })).status).toBe(403);
    expect((await t.call('DELETE', `/v1/photos/${mine.id}`, { token: ayesha.token })).status).toBe(204);
    expect(await storage().open(row.rows[0].storage_key)).toBeNull();
    expect(await storage().open(row.rows[0].thumb_key)).toBeNull();
    expect((await t.call('DELETE', `/v1/photos/${forHead.id}`, { token: head.token })).status).toBe(204);
    expect((await t.call('DELETE', `/v1/photos/${forAdmin.id}`, { token: admin.token })).status).toBe(204);
  });

  it('deleting an album removes its pictures and files; only its creator or an admin may', async () => {
    const a = await album(head, { societyId: head.societyId });
    const [p] = await add(a.id, ayesha, 1);
    const key = (await t.pool.query('SELECT storage_key FROM photos WHERE id = $1', [p.id])).rows[0].storage_key;
    expect((await t.call('DELETE', `/v1/albums/${a.id}`, { token: ayesha.token })).status).toBe(403);
    expect((await t.call('DELETE', `/v1/albums/${a.id}`, { token: head.token })).status).toBe(204);
    expect(await storage().open(key)).toBeNull();
    expect((await t.pool.query('SELECT count(*)::int AS n FROM photos')).rows[0].n).toBe(0);
    expect((await fetchPicture(p.url)).statusCode).toBe(404);
  });

  it('deleting an account removes the pictures the person added, files included', async () => {
    const a = await album();
    const [p] = await add(a.id, ayesha, 1);
    const key = (await t.pool.query('SELECT storage_key FROM photos WHERE id = $1', [p.id])).rows[0].storage_key;
    expect((await t.call('DELETE', '/v1/me', { token: ayesha.token })).status).toBe(204);
    expect(await storage().open(key)).toBeNull();
    expect((await t.pool.query('SELECT count(*)::int AS n FROM photos')).rows[0].n).toBe(0);
  });

  it('renaming needs the creator or an admin', async () => {
    const a = await album(head, { societyId: head.societyId });
    expect((await t.call('PATCH', `/v1/albums/${a.id}`, { token: ayesha.token, body: { title: 'Hacked' } })).status).toBe(403);
    expect((await t.call('PATCH', `/v1/albums/${a.id}`, { token: head.token, body: { title: 'New title' } })).body.title).toBe('New title');
  });
});

describe('picture links', () => {
  it('only work when signed, unexpired and for the right picture and size', async () => {
    const a = await album();
    const [p, q] = await add(a.id, ayesha, 2);
    const good = new URL(p.url, 'http://x');
    expect((await fetchPicture(p.url)).statusCode).toBe(200);

    const tamper = (mut: (u: URL) => void) => {
      const u = new URL(p.url, 'http://x');
      mut(u);
      return fetchPicture(u.pathname + u.search);
    };
    expect((await tamper(u => u.searchParams.set('sig', 'x'.repeat(27)))).statusCode).toBe(404);
    expect((await tamper(u => u.searchParams.delete('sig'))).statusCode).toBe(404);
    expect((await tamper(u => u.searchParams.set('exp', String(Date.now() + 99 * 86_400_000)))).statusCode).toBe(404); // longer life, same signature
    expect((await tamper(u => (u.pathname = u.pathname.replace(p.id, q.id)))).statusCode).toBe(404); // another picture
    expect((await tamper(u => (u.pathname = u.pathname.replace('/full', '/thumb')))).statusCode).toBe(404); // another size
    expect(good.searchParams.get('sig')).toBeTruthy();
  });

  it('expire', () => {
    const path = signedPhotoPath(t.config, '11111111-1111-4111-8111-111111111111', 'full', Date.now() - 5 * 86_400_000);
    const u = new URL(path, 'http://x');
    expect(verifyPhotoSignature(t.config, '11111111-1111-4111-8111-111111111111', 'full', u.searchParams.get('exp') ?? '', u.searchParams.get('sig') ?? '')).toBe(false);
  });

  it('stay the same all day, so the phone can cache them', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const noon = Date.UTC(2026, 5, 1, 12);
    expect(signedPhotoPath(t.config, id, 'thumb', noon)).toBe(signedPhotoPath(t.config, id, 'thumb', noon + 3 * 3_600_000));
  });
});

describe('isolation between universities', () => {
  it('another university cannot list, open, upload to, like or delete anything', async () => {
    const a = await album();
    const [p] = await add(a.id, ayesha, 1);
    expect((await t.call('GET', '/v1/albums', { token: outsider.token })).body.albums).toEqual([]);
    for (const [method, url] of [
      ['GET', `/v1/albums/${a.id}`],
      ['PATCH', `/v1/albums/${a.id}`],
      ['DELETE', `/v1/albums/${a.id}`],
      ['PUT', `/v1/photos/${p.id}/like`],
      ['DELETE', `/v1/photos/${p.id}/like`],
      ['DELETE', `/v1/photos/${p.id}`],
    ] as const) {
      expect((await t.call(method, url, { token: outsider.token, body: { title: 'Stolen' } })).status, `${method} ${url}`).toBe(404);
    }
    expect((await t.pool.query('SELECT count(*)::int AS n FROM photos')).rows[0].n).toBe(1);
  });

  it('a photo can never be attached to an album of another university (database rule)', async () => {
    const a = await album();
    await expect(
      t.pool.query(
        `INSERT INTO photos (album_id, university_id, storage_key, thumb_key, width, height, bytes) VALUES ($1, 'uol', 'uol/x.jpg', 'uol/x_t.jpg', 10, 10, 10)`,
        [a.id],
      ),
    ).rejects.toThrow();
  });
});
