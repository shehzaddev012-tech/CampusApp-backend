import { randomUUID } from 'node:crypto';

import multipart from '@fastify/multipart';

import { badRequest, notFound } from '../lib/errors.js';
import { uuid } from '../lib/http.js';
import { readMultipart } from '../lib/multipart.js';
import { MAX_UPLOAD_BYTES, processImage } from '../media/image.js';
import { signedPath, verifySignature } from '../media/signedUrl.js';
import type { Routes } from './types.js';

const MAX_FILES = 3;
const MAX_UNATTACHED = 12;

export const mediaDto = (config: Parameters<typeof signedPath>[0], m: { id: string; width: number; height: number }) => ({
  id: m.id,
  url: signedPath(config, 'media', m.id, 'full'),
  thumbUrl: signedPath(config, 'media', m.id, 'thumb'),
  width: m.width,
  height: m.height,
});

/**
 * Pictures that belong to something other than an album (book photos ...).
 * Upload first, get ids back, then attach the ids to the thing being created.
 */
export const mediaRoutes: Routes = async (app, { deps, guards }) => {
  const { config, pool, storage } = deps;

  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_FILES, fields: 5, parts: MAX_FILES + 5 } });

  app.post('/media', { preHandler: guards.member, config: { rateLimit: { max: config.nodeEnv === 'test' ? 100_000 : 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    const m = req.member!;
    const { files } = await readMultipart(req, { maxFiles: MAX_FILES, maxBytes: MAX_UPLOAD_BYTES });
    if (files.length === 0) {
      throw badRequest('Choose at least one picture.');
    }
    // Pictures that were uploaded but never used get cleaned up, so nobody can fill the disk.
    const stale = await pool.query<{ id: string; storage_key: string; thumb_key: string }>(
      `DELETE FROM media WHERE owner_id = $1 AND created_at < now() - interval '1 day'
         AND NOT EXISTS (SELECT 1 FROM book_photos b WHERE b.media_id = media.id)
         AND NOT EXISTS (SELECT 1 FROM stories s WHERE s.media_id = media.id) RETURNING id, storage_key, thumb_key`,
      [m.userId],
    );
    await Promise.all(stale.rows.flatMap(r => [storage.delete(r.storage_key), storage.delete(r.thumb_key)]).map(p => p.catch(() => undefined)));
    const waiting = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM media m WHERE owner_id = $1 AND NOT EXISTS (SELECT 1 FROM book_photos b WHERE b.media_id = m.id) AND NOT EXISTS (SELECT 1 FROM stories s WHERE s.media_id = m.id)',
      [m.userId],
    );
    if ((waiting.rows[0]?.n ?? 0) + files.length > MAX_UNATTACHED) {
      throw badRequest('Too many unused pictures. Finish the post you are working on first.');
    }

    const saved: { id: string; width: number; height: number; keys: string[] }[] = [];
    try {
      for (const f of files) {
        const image = await processImage(f.data);
        const id = randomUUID();
        const base = `${m.universityId}/media/${id}`;
        await storage.put(`${base}.jpg`, image.full, 'image/jpeg');
        await storage.put(`${base}_t.jpg`, image.thumb, 'image/jpeg');
        await pool.query(
          'INSERT INTO media (id, university_id, owner_id, storage_key, thumb_key, width, height, bytes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [id, m.universityId, m.userId, `${base}.jpg`, `${base}_t.jpg`, image.width, image.height, image.full.length],
        );
        saved.push({ id, width: image.width, height: image.height, keys: [`${base}.jpg`, `${base}_t.jpg`] });
      }
    } catch (err) {
      await Promise.all(saved.flatMap(s => s.keys).map(k => storage.delete(k).catch(() => undefined)));
      await pool.query('DELETE FROM media WHERE id = ANY($1::uuid[])', [saved.map(s => s.id)]);
      throw err;
    }
    return reply.status(201).send({ media: saved.map(s => mediaDto(config, s)) });
  });

  // The picture itself: the signed link is the proof (see media/signedUrl.ts).
  app.get<{ Params: { id: string; size: string }; Querystring: { exp?: string; sig?: string } }>('/media/:id/:size', async (req, reply) => {
    const { id, size } = req.params;
    if ((size !== 'full' && size !== 'thumb') || !verifySignature(config, 'media', id, size, req.query.exp, req.query.sig)) {
      throw notFound();
    }
    const row = await pool.query<{ storage_key: string; thumb_key: string }>('SELECT storage_key, thumb_key FROM media WHERE id = $1', [uuid(id)]);
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
