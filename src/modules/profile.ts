import { createHmac } from 'node:crypto';

import multipart from '@fastify/multipart';
import sharp from 'sharp';
import { z } from 'zod';

import { badRequest, notFound } from '../lib/errors.js';
import { parse, uuid } from '../lib/http.js';
import { readMultipart } from '../lib/multipart.js';
import { safeEqual } from '../lib/secrets.js';
import { MAX_UPLOAD_BYTES } from '../media/image.js';
import type { Config } from '../config.js';
import type { Routes } from './types.js';

const AVATAR_SIZE = 480;
export const avatarKey = (userId: string) => `avatars/${userId}.jpg`;

const sign = (config: Config, userId: string) => createHmac('sha256', config.jwtSecret).update(`avatar|${userId}`).digest('base64url').slice(0, 27);

/**
 * The link to someone's profile picture. It does not expire (so it can be saved in the account), but it cannot be
 * guessed from a user id, and `v` changes whenever the picture changes so phones fetch the new one.
 */
export const avatarPath = (config: Config, userId: string, version: number) => `/v1/avatars/${userId}/${sign(config, userId)}?v=${version}`;

/** My profile: change my name, set or remove my picture. */
export const profileRoutes: Routes = async (app, { deps, guards }) => {
  const { config, pool, storage } = deps;
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2, parts: 3 } });

  app.patch('/me', { preHandler: guards.user }, async req => {
    const body = parse(z.object({ name: z.string().trim().min(2, 'Your name needs at least 2 characters.').max(80) }), req.body);
    const { rows } = await pool.query<{ id: string; name: string; email: string; photo_url: string | null }>('UPDATE users SET name = $2 WHERE id = $1 RETURNING id, name, email, photo_url', [req.user!.id, body.name]);
    const u = rows[0]!;
    return { uid: u.id, name: u.name, email: u.email, photoUrl: u.photo_url };
  });

  app.post('/me/photo', { preHandler: guards.user, config: { rateLimit: { max: config.nodeEnv === 'test' ? 100_000 : 20, timeWindow: '1 hour' } } }, async req => {
    const { files } = await readMultipart(req, { maxFiles: 1, maxBytes: MAX_UPLOAD_BYTES });
    const file = files[0];
    if (!file) {
      throw badRequest('Choose a picture.');
    }
    let jpeg: Buffer;
    try {
      // A square, centred crop; decoding it again also strips location data and proves it is a picture.
      jpeg = await sharp(file.data, { limitInputPixels: 100_000_000 })
        .rotate()
        .flatten({ background: '#ffffff' })
        .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'attention' })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();
    } catch {
      throw badRequest('That file is not a picture we can use. Send a JPEG, PNG or WebP photo.');
    }
    const id = req.user!.id;
    await storage.put(avatarKey(id), jpeg, 'image/jpeg');
    const version = Date.now();
    const url = avatarPath(config, id, version);
    await pool.query('UPDATE users SET photo_url = $2, photo_version = $3 WHERE id = $1', [id, url, version]);
    return { photoUrl: url };
  });

  app.delete('/me/photo', { preHandler: guards.user }, async (req, reply) => {
    await storage.delete(avatarKey(req.user!.id)).catch(() => undefined);
    await pool.query('UPDATE users SET photo_url = NULL, photo_version = 0 WHERE id = $1', [req.user!.id]);
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string; sig: string } }>('/avatars/:id/:sig', async (req, reply) => {
    const id = uuid(req.params.id);
    if (!safeEqual(sign(config, id), req.params.sig)) {
      throw notFound();
    }
    const file = await storage.open(avatarKey(id));
    if (!file) {
      throw notFound();
    }
    return reply
      .header('Content-Type', 'image/jpeg')
      .header('Content-Length', file.size)
      .header('Cache-Control', 'public, max-age=31536000, immutable') // the link changes with the picture
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .send(file.stream);
  });
};
