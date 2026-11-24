import { randomUUID } from 'node:crypto';

import multipart from '@fastify/multipart';
import { z } from 'zod';

import { ADMIN_ROLES, EVENT_CATEGORIES, ORGANISER_ROLES, type Role } from '../domain.js';
import { withTx, type Db } from '../db/pool.js';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { ms, parse, uuid } from '../lib/http.js';
import { MAX_UPLOAD_BYTES, processImage } from '../media/image.js';
import { signedPhotoPath, verifyPhotoSignature } from '../media/signedUrl.js';
import type { Storage } from '../storage/index.js';
import { canManageSociety } from './societies.js';
import type { Routes } from './types.js';

const MAX_FILES_PER_REQUEST = 10;
const MAX_PHOTOS_PER_USER_PER_DAY = 200;
const PAGE = 60;

interface AlbumRow {
  id: string;
  university_id: string;
  title: string;
  category: string;
  event_id: string | null;
  society_id: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: Date;
  photo_count: number;
  cover_photo_id: string | null;
  cover_width: number | null;
  cover_height: number | null;
}

const ALBUM_SELECT = `
  SELECT a.*, u.name AS created_by_name,
    (SELECT count(*)::int FROM photos p WHERE p.album_id = a.id) AS photo_count,
    cover.id AS cover_photo_id, cover.width AS cover_width, cover.height AS cover_height
  FROM albums a
  LEFT JOIN users u ON u.id = a.created_by
  LEFT JOIN LATERAL (
    SELECT p.id, p.width, p.height FROM photos p WHERE p.album_id = a.id
     ORDER BY (SELECT count(*) FROM photo_likes l WHERE l.photo_id = p.id) DESC, p.created_at DESC LIMIT 1
  ) cover ON true`;

interface PhotoRow {
  id: string;
  album_id: string;
  university_id: string;
  uploader_id: string | null;
  uploader_name: string | null;
  storage_key: string;
  thumb_key: string;
  width: number;
  height: number;
  created_at: Date;
  like_count: number;
  liked: boolean;
}

const PHOTO_SELECT = `
  SELECT p.*, u.name AS uploader_name,
    (SELECT count(*)::int FROM photo_likes l WHERE l.photo_id = p.id) AS like_count,
    EXISTS (SELECT 1 FROM photo_likes l WHERE l.photo_id = p.id AND l.user_id = $2) AS liked
  FROM photos p LEFT JOIN users u ON u.id = p.uploader_id`;

export const albumsRoutes: Routes = async (app, { deps, guards }) => {
  const { config, pool, push, storage } = deps;
  const member = { preHandler: guards.member };

  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_FILES_PER_REQUEST, fields: 5, parts: MAX_FILES_PER_REQUEST + 5 } });

  const albumDto = (a: AlbumRow, viewer: { userId: string; role: Role }) => ({
    id: a.id,
    title: a.title,
    category: a.category,
    eventId: a.event_id,
    societyId: a.society_id,
    photoCount: a.photo_count,
    cover: a.cover_photo_id
      ? { photoId: a.cover_photo_id, thumbUrl: signedPhotoPath(config, a.cover_photo_id, 'thumb'), width: a.cover_width, height: a.cover_height }
      : null,
    createdBy: a.created_by,
    createdByName: a.created_by_name,
    createdAt: ms(a.created_at),
    canManage: a.created_by === viewer.userId || ADMIN_ROLES.includes(viewer.role),
  });

  const photoDto = (p: PhotoRow, viewer: { userId: string; role: Role }, albumCreator: string | null) => ({
    id: p.id,
    albumId: p.album_id,
    url: signedPhotoPath(config, p.id, 'full'),
    thumbUrl: signedPhotoPath(config, p.id, 'thumb'),
    width: p.width,
    height: p.height,
    likeCount: p.like_count,
    liked: p.liked,
    uploaderId: p.uploader_id,
    uploaderName: p.uploader_name,
    createdAt: ms(p.created_at),
    canDelete: p.uploader_id === viewer.userId || albumCreator === viewer.userId || ADMIN_ROLES.includes(viewer.role),
  });

  async function loadAlbum(db: Db, id: string, universityId: string): Promise<AlbumRow> {
    const { rows } = await db.query<AlbumRow>(`${ALBUM_SELECT} WHERE a.id = $1 AND a.university_id = $2`, [id, universityId]);
    if (!rows[0]) {
      throw notFound('Album not found.');
    }
    return rows[0];
  }

  async function loadPhoto(db: Db, id: string, universityId: string, userId: string): Promise<PhotoRow & { album_creator: string | null }> {
    const { rows } = await db.query<PhotoRow & { album_creator: string | null }>(
      `SELECT x.*, (SELECT created_by FROM albums WHERE id = x.album_id) AS album_creator FROM (${PHOTO_SELECT} WHERE p.id = $1 AND p.university_id = $3) x`,
      [id, userId, universityId],
    );
    if (!rows[0]) {
      throw notFound('Photo not found.');
    }
    return rows[0];
  }

  const removeFiles = async (keys: string[]) => {
    await Promise.all(keys.map(k => storage.delete(k).catch(() => undefined)));
  };

  // ── albums ─────────────────────────────────────────────────────────────────

  app.get('/albums', member, async req => {
    const m = req.member!;
    const { rows } = await pool.query<AlbumRow>(`${ALBUM_SELECT} WHERE a.university_id = $1 ORDER BY COALESCE((SELECT max(p.created_at) FROM photos p WHERE p.album_id = a.id), a.created_at) DESC LIMIT 200`, [m.universityId]);
    return { albums: rows.map(a => albumDto(a, { userId: m.userId, role: m.role })) };
  });

  const albumFields = { title: z.string().trim().min(2).max(80), category: z.enum(EVENT_CATEGORIES) };

  app.post('/albums', { preHandler: guards.roles(...ORGANISER_ROLES) }, async (req, reply) => {
    const m = req.member!;
    const body = parse(z.object({ ...albumFields, eventId: z.string().uuid().nullable().default(null), societyId: z.string().uuid().nullable().default(null) }), req.body);

    let societyId = body.societyId;
    if (body.eventId) {
      const ev = await pool.query<{ society_id: string | null }>('SELECT society_id FROM events WHERE id = $1 AND university_id = $2', [body.eventId, m.universityId]);
      if (!ev.rows[0]) {
        throw notFound('Event not found.');
      }
      societyId ??= ev.rows[0].society_id;
    }
    if (societyId && !(await canManageSociety(pool, societyId, m.universityId, m.userId, m.role))) {
      throw forbidden('Only the society head or an admin can create albums for this society.');
    }
    if (!societyId && !ADMIN_ROLES.includes(m.role)) {
      throw forbidden('Choose the society this album is for.');
    }
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO albums (university_id, title, category, event_id, society_id, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [m.universityId, body.title, body.category, body.eventId, societyId, m.userId],
    );
    return reply.status(201).send(albumDto(await loadAlbum(pool, (rows[0] as { id: string }).id, m.universityId), { userId: m.userId, role: m.role }));
  });

  app.get<{ Params: { id: string }; Querystring: { before?: string } }>('/albums/:id', member, async req => {
    const m = req.member!;
    const id = uuid(req.params.id);
    const album = await loadAlbum(pool, id, m.universityId);
    const before = Number(req.query.before);
    const { rows } = await pool.query<PhotoRow>(
      `${PHOTO_SELECT} WHERE p.album_id = $1 AND ($3::bigint IS NULL OR p.created_at < to_timestamp($3 / 1000.0)) ORDER BY p.created_at DESC LIMIT ${PAGE + 1}`,
      [id, m.userId, Number.isFinite(before) && before > 0 ? before : null],
    );
    const page = rows.slice(0, PAGE);
    const viewer = { userId: m.userId, role: m.role };
    // The best shot is the picture the most people liked (at least one like).
    const best = await pool.query<{ id: string }>(
      `SELECT p.id FROM photos p JOIN photo_likes l ON l.photo_id = p.id WHERE p.album_id = $1
        GROUP BY p.id ORDER BY count(*) DESC, p.created_at DESC LIMIT 1`,
      [id],
    );
    return {
      album: albumDto(album, viewer),
      photos: page.map(p => photoDto(p, viewer, album.created_by)),
      bestPhotoId: best.rows[0]?.id ?? null,
      nextBefore: rows.length > PAGE ? ms(page[page.length - 1]?.created_at) : null,
    };
  });

  app.patch<{ Params: { id: string } }>('/albums/:id', member, async req => {
    const m = req.member!;
    const id = uuid(req.params.id);
    const body = parse(z.object({ title: albumFields.title.optional(), category: albumFields.category.optional() }), req.body);
    const album = await loadAlbum(pool, id, m.universityId);
    if (album.created_by !== m.userId && !ADMIN_ROLES.includes(m.role)) {
      throw forbidden('Only the album creator or an admin can change this album.');
    }
    await pool.query('UPDATE albums SET title = COALESCE($2, title), category = COALESCE($3, category) WHERE id = $1', [id, body.title ?? null, body.category ?? null]);
    return albumDto(await loadAlbum(pool, id, m.universityId), { userId: m.userId, role: m.role });
  });

  app.delete<{ Params: { id: string } }>('/albums/:id', member, async (req, reply) => {
    const m = req.member!;
    const id = uuid(req.params.id);
    const album = await loadAlbum(pool, id, m.universityId);
    if (album.created_by !== m.userId && !ADMIN_ROLES.includes(m.role)) {
      throw forbidden('Only the album creator or an admin can delete this album.');
    }
    const files = await pool.query<{ id: string; storage_key: string; thumb_key: string }>('SELECT id, storage_key, thumb_key FROM photos WHERE album_id = $1', [id]);
    await pool.query('DELETE FROM albums WHERE id = $1 AND university_id = $2', [id, m.universityId]);
    await removeFiles(files.rows.flatMap(f => [f.storage_key, f.thumb_key]));
    return reply.status(204).send();
  });

  // ── photos ─────────────────────────────────────────────────────────────────

  // Any approved member of the university can add pictures to its albums (multipart field "photos", up to 10 files).
  app.post<{ Params: { id: string } }>('/albums/:id/photos', { preHandler: guards.member, config: { rateLimit: { max: config.nodeEnv === 'test' ? 100_000 : 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const m = req.member!;
    const id = uuid(req.params.id);
    await loadAlbum(pool, id, m.universityId);

    const today = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM photos WHERE uploader_id = $1 AND created_at > now() - interval '1 day'", [m.userId]);
    const already = today.rows[0]?.n ?? 0;

    const stored: { id: string; storageKey: string; thumbKey: string; width: number; height: number; bytes: number }[] = [];
    try {
      for await (const part of req.files()) {
        if (stored.length + already >= MAX_PHOTOS_PER_USER_PER_DAY) {
          throw new AppError(429, 'upload_limit', `You can add up to ${MAX_PHOTOS_PER_USER_PER_DAY} photos a day.`);
        }
        const input = await part.toBuffer();
        if (part.file.truncated) {
          throw badRequest(`A photo is larger than ${Math.round(MAX_UPLOAD_BYTES / 1_048_576)} MB.`);
        }
        const image = await processImage(input);
        const photoId = randomUUID();
        const base = `${m.universityId}/${id}/${photoId}`;
        await storage.put(`${base}.jpg`, image.full, 'image/jpeg');
        await storage.put(`${base}_t.jpg`, image.thumb, 'image/jpeg');
        stored.push({ id: photoId, storageKey: `${base}.jpg`, thumbKey: `${base}_t.jpg`, width: image.width, height: image.height, bytes: image.full.length });
      }
      if (stored.length === 0) {
        throw badRequest('Choose at least one photo.');
      }
      await withTx(pool, async c => {
        for (const s of stored) {
          await c.query(
            `INSERT INTO photos (id, album_id, university_id, uploader_id, storage_key, thumb_key, width, height, bytes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [s.id, id, m.universityId, m.userId, s.storageKey, s.thumbKey, s.width, s.height, s.bytes],
          );
        }
      });
    } catch (err) {
      await removeFiles(stored.flatMap(s => [s.storageKey, s.thumbKey])); // nothing half-saved is left behind
      throw err;
    }
    const album = await loadAlbum(pool, id, m.universityId);
    const rows = await pool.query<PhotoRow>(`${PHOTO_SELECT} WHERE p.id = ANY($1::uuid[]) ORDER BY p.created_at DESC`, [stored.map(s => s.id), m.userId]);
    const viewer = { userId: m.userId, role: m.role };
    return reply.status(201).send({ photos: rows.rows.map(p => photoDto(p, viewer, album.created_by)) });
  });

  app.delete<{ Params: { id: string } }>('/photos/:id', member, async (req, reply) => {
    const m = req.member!;
    const photo = await loadPhoto(pool, uuid(req.params.id), m.universityId, m.userId);
    if (photo.uploader_id !== m.userId && photo.album_creator !== m.userId && !ADMIN_ROLES.includes(m.role)) {
      throw forbidden('Only the person who added this photo, the album creator or an admin can remove it.');
    }
    await pool.query('DELETE FROM photos WHERE id = $1 AND university_id = $2', [photo.id, m.universityId]);
    await removeFiles([photo.storage_key, photo.thumb_key]);
    return reply.status(204).send();
  });

  app.put<{ Params: { id: string } }>('/photos/:id/like', member, async req => {
    const m = req.member!;
    const photo = await loadPhoto(pool, uuid(req.params.id), m.universityId, m.userId);
    await pool.query('INSERT INTO photo_likes (photo_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [photo.id, m.userId]);
    const count = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM photo_likes WHERE photo_id = $1', [photo.id]);
    return { liked: true, likeCount: count.rows[0]?.n ?? 0 };
  });

  app.delete<{ Params: { id: string } }>('/photos/:id/like', member, async req => {
    const m = req.member!;
    const photo = await loadPhoto(pool, uuid(req.params.id), m.universityId, m.userId);
    await pool.query('DELETE FROM photo_likes WHERE photo_id = $1 AND user_id = $2', [photo.id, m.userId]);
    const count = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM photo_likes WHERE photo_id = $1', [photo.id]);
    return { liked: false, likeCount: count.rows[0]?.n ?? 0 };
  });

  // ── the pictures themselves ────────────────────────────────────────────────
  // No sign-in header here (an <Image> cannot always send one). The link itself is the proof: it is signed,
  // tied to one picture and one size, and expires. Links are only given to approved members of the university.
  app.get<{ Params: { id: string; size: string }; Querystring: { exp?: string; sig?: string } }>('/files/:id/:size', async (req, reply) => {
    const { id, size } = req.params;
    if (!verifyPhotoSignature(config, id, size, req.query.exp, req.query.sig)) {
      throw notFound();
    }
    const row = await pool.query<{ storage_key: string; thumb_key: string }>('SELECT storage_key, thumb_key FROM photos WHERE id = $1', [uuid(id)]);
    const keys = row.rows[0];
    const file = keys ? await storage.open(size === 'thumb' ? keys.thumb_key : keys.storage_key) : null;
    if (!file) {
      throw notFound();
    }
    return reply
      .header('Content-Type', 'image/jpeg')
      .header('Content-Length', file.size)
      .header('Cache-Control', 'private, max-age=86400')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .send(file.stream);
  });
};

/** Removes every picture a person added (used when they delete their account). */
export async function deleteUserPhotos(pool: Db, storage: Storage, userId: string): Promise<void> {
  const { rows } = await pool.query<{ storage_key: string; thumb_key: string }>('DELETE FROM photos WHERE uploader_id = $1 RETURNING storage_key, thumb_key', [userId]);
  await Promise.all(rows.flatMap(r => [storage.delete(r.storage_key), storage.delete(r.thumb_key)]).map(p => p.catch(() => undefined)));
}
