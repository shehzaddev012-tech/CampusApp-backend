import { randomUUID } from 'node:crypto';

import multipart from '@fastify/multipart';

import { ADMIN_ROLES } from '../domain.js';
import type { Db } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { ms, uuid } from '../lib/http.js';
import { readMultipart } from '../lib/multipart.js';
import { MAX_UPLOAD_BYTES, processImage } from '../media/image.js';
import type { Storage } from '../storage/index.js';
import { mediaDto } from './media.js';
import type { Routes } from './types.js';

const MAX_LIVE_PER_USER = 10;

/** Deletes stories that ran out of time, with their pictures. Safe to call at any moment. */
export async function purgeExpiredStories(db: Db, storage: Storage): Promise<number> {
  const gone = await db.query<{ media_id: string | null }>('DELETE FROM stories WHERE expires_at <= now() RETURNING media_id');
  if (gone.rows.length === 0) {
    return 0;
  }
  const files = await db.query<{ storage_key: string; thumb_key: string }>('DELETE FROM media WHERE id = ANY($1::uuid[]) RETURNING storage_key, thumb_key', [gone.rows.map(r => r.media_id).filter(Boolean)]);
  await Promise.all(files.rows.flatMap(f => [storage.delete(f.storage_key), storage.delete(f.thumb_key)]).map(p => p.catch(() => undefined)));
  return gone.rows.length;
}

/** Removes one story and its picture (the owner, an admin, or a report being actioned). */
export async function removeStory(db: Db, storage: Storage, id: string, universityId: string): Promise<boolean> {
  const s = await db.query<{ media_id: string | null }>('DELETE FROM stories WHERE id = $1 AND university_id = $2 RETURNING media_id', [id, universityId]);
  if (!s.rows[0]) {
    return false;
  }
  if (!s.rows[0].media_id) {
    return true; // a words-only story has no picture to remove
  }
  const f = await db.query<{ storage_key: string; thumb_key: string }>('DELETE FROM media WHERE id = $1 RETURNING storage_key, thumb_key', [s.rows[0].media_id]);
  await Promise.all(f.rows.flatMap(x => [storage.delete(x.storage_key), storage.delete(x.thumb_key)]).map(p => p.catch(() => undefined)));
  return true;
}

interface StoryRow {
  id: string;
  user_id: string;
  author: string;
  photo_url: string | null;
  caption: string;
  created_at: Date;
  expires_at: Date;
  media_id: string | null;
  width: number | null;
  height: number | null;
  bg: string;
  seen: boolean;
  views: number;
}

export const storiesRoutes: Routes = async (app, { deps, guards }) => {
  const { config, pool, storage } = deps;
  const member = { preHandler: guards.member };

  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4, parts: 6 } });

  const dto = (r: StoryRow, me: string) => ({
    id: r.id,
    caption: r.caption,
    createdAt: ms(r.created_at),
    expiresAt: ms(r.expires_at),
    // null for a story that is only words
    image: r.media_id ? mediaDto(config, { id: r.media_id, width: r.width ?? 0, height: r.height ?? 0 }) : null,
    bg: r.bg,
    seen: r.user_id === me ? true : r.seen,
    // Only the person who posted it learns how many people looked.
    viewCount: r.user_id === me ? r.views : null,
  });

  // A picture and an optional line (multipart: any file field, text field "caption"). Lasts 24 hours.
  app.post('/stories', { preHandler: guards.member, config: { rateLimit: { max: config.nodeEnv === 'test' ? 100_000 : 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    const m = req.member!;
    const { fields, files } = await readMultipart(req, { maxFiles: 1, maxBytes: MAX_UPLOAD_BYTES });
    const file = files[0];
    const caption = (fields.caption ?? '').trim();
    if (!file && caption.length === 0) {
      throw badRequest('Write something or choose a picture for your story.');
    }
    if (caption.length > (file ? 140 : 280)) {
      throw badRequest(file ? 'A story line can have up to 140 characters.' : 'A story can have up to 280 characters.');
    }
    const bg = /^#[0-9a-fA-F]{6}$/.test(fields.bg ?? '') ? (fields.bg as string) : '#14231D';
    await purgeExpiredStories(pool, storage);
    const live = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM stories WHERE user_id = $1 AND expires_at > now()', [m.userId]);
    if ((live.rows[0]?.n ?? 0) >= MAX_LIVE_PER_USER) {
      throw conflict(`You can have up to ${MAX_LIVE_PER_USER} stories at a time. Delete one or wait for it to expire.`, 'too_many_stories');
    }
    if (!file) {
      const { rows } = await pool.query<{ id: string; created_at: Date; expires_at: Date }>(
        'INSERT INTO stories (university_id, user_id, caption, bg) VALUES ($1, $2, $3, $4) RETURNING id, created_at, expires_at',
        [m.universityId, m.userId, caption, bg],
      );
      const s = rows[0]!;
      return reply.status(201).send(dto({ id: s.id, user_id: m.userId, author: req.user!.name, photo_url: null, caption, created_at: s.created_at, expires_at: s.expires_at, media_id: null, width: null, height: null, bg, seen: true, views: 0 }, m.userId));
    }
    const image = await processImage(file.data);
    const mediaId = randomUUID();
    const base = `${m.universityId}/stories/${mediaId}`;
    await storage.put(`${base}.jpg`, image.full, 'image/jpeg');
    await storage.put(`${base}_t.jpg`, image.thumb, 'image/jpeg');
    try {
      await pool.query(
        'INSERT INTO media (id, university_id, owner_id, storage_key, thumb_key, width, height, bytes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [mediaId, m.universityId, m.userId, `${base}.jpg`, `${base}_t.jpg`, image.width, image.height, image.full.length],
      );
      const { rows } = await pool.query<{ id: string; created_at: Date; expires_at: Date }>(
        'INSERT INTO stories (university_id, user_id, media_id, caption) VALUES ($1, $2, $3, $4) RETURNING id, created_at, expires_at',
        [m.universityId, m.userId, mediaId, caption],
      );
      const s = rows[0]!;
      return reply.status(201).send(dto({ id: s.id, user_id: m.userId, author: req.user!.name, photo_url: null, caption, created_at: s.created_at, expires_at: s.expires_at, media_id: mediaId, width: image.width, height: image.height, bg: '', seen: true, views: 0 }, m.userId));
    } catch (err) {
      await Promise.all([storage.delete(`${base}.jpg`), storage.delete(`${base}_t.jpg`)].map(p => p.catch(() => undefined)));
      await pool.query('DELETE FROM media WHERE id = $1', [mediaId]);
      throw err;
    }
  });

  // Live stories of my university, one row per person. Mine first, then people I have not seen, newest first.
  // Anyone I blocked, or who blocked me, is left out.
  app.get('/stories', member, async req => {
    const m = req.member!;
    const { rows } = await pool.query<StoryRow>(
      `SELECT s.id, s.user_id, u.name AS author, u.photo_url, s.caption, s.created_at, s.expires_at, s.media_id, s.bg, md.width, md.height,
              EXISTS (SELECT 1 FROM story_views v WHERE v.story_id = s.id AND v.viewer_id = $2) AS seen,
              (SELECT count(*)::int FROM story_views v WHERE v.story_id = s.id) AS views
         FROM stories s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN media md ON md.id = s.media_id
         JOIN memberships mb ON mb.user_id = s.user_id AND mb.university_id = s.university_id AND mb.status = 'active'
        WHERE s.university_id = $1 AND s.expires_at > now()
          AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $2 AND b.blocked_id = s.user_id) OR (b.blocker_id = s.user_id AND b.blocked_id = $2))
        ORDER BY s.created_at`,
      [m.universityId, m.userId],
    );
    const byUser = new Map<string, { uid: string; name: string; photoUrl: string | null; mine: boolean; stories: ReturnType<typeof dto>[] }>();
    for (const r of rows) {
      let g = byUser.get(r.user_id);
      if (!g) {
        g = { uid: r.user_id, name: r.author, photoUrl: r.photo_url, mine: r.user_id === m.userId, stories: [] };
        byUser.set(r.user_id, g);
      }
      g.stories.push(dto(r, m.userId));
    }
    const people = [...byUser.values()].map(g => ({ ...g, hasUnseen: g.stories.some(s => !s.seen), latestAt: g.stories[g.stories.length - 1]!.createdAt ?? 0 }));
    people.sort((a, b) => Number(b.mine) - Number(a.mine) || Number(b.hasUnseen) - Number(a.hasUnseen) || b.latestAt - a.latestAt);
    return { people };
  });

  /** A live story I am allowed to see, or 404. */
  const visible = async (id: string, universityId: string, userId: string) => {
    const { rows } = await pool.query<{ id: string; user_id: string }>(
      `SELECT s.id, s.user_id FROM stories s
        WHERE s.id = $1 AND s.university_id = $2 AND s.expires_at > now()
          AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $3 AND b.blocked_id = s.user_id) OR (b.blocker_id = s.user_id AND b.blocked_id = $3))`,
      [id, universityId, userId],
    );
    if (!rows[0]) {
      throw notFound('This story is no longer available.');
    }
    return rows[0];
  };

  app.post<{ Params: { id: string } }>('/stories/:id/view', member, async (req, reply) => {
    const m = req.member!;
    const s = await visible(uuid(req.params.id), m.universityId, m.userId);
    if (s.user_id !== m.userId) {
      await pool.query('INSERT INTO story_views (story_id, viewer_id, university_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [s.id, m.userId, m.universityId]);
    }
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>('/stories/:id/viewers', member, async req => {
    const m = req.member!;
    const s = await visible(uuid(req.params.id), m.universityId, m.userId);
    if (s.user_id !== m.userId) {
      throw forbidden('Only the person who posted a story can see who viewed it.');
    }
    const { rows } = await pool.query<{ id: string; name: string; viewed_at: Date }>(
      'SELECT u.id, u.name, v.viewed_at FROM story_views v JOIN users u ON u.id = v.viewer_id WHERE v.story_id = $1 ORDER BY v.viewed_at DESC LIMIT 200',
      [s.id],
    );
    return { viewers: rows.map(r => ({ uid: r.id, name: r.name, viewedAt: ms(r.viewed_at) })) };
  });

  app.delete<{ Params: { id: string } }>('/stories/:id', member, async (req, reply) => {
    const m = req.member!;
    const id = uuid(req.params.id);
    const own = await pool.query<{ user_id: string }>('SELECT user_id FROM stories WHERE id = $1 AND university_id = $2', [id, m.universityId]);
    if (!own.rows[0]) {
      throw notFound('Story not found.');
    }
    if (own.rows[0].user_id !== m.userId && !ADMIN_ROLES.includes(m.role)) {
      throw forbidden('You can only delete your own stories.');
    }
    await removeStory(pool, storage, id, m.universityId);
    return reply.status(204).send();
  });
};
