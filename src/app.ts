import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type pg from 'pg';

import type { Config } from './config.js';
import { AppError } from './lib/errors.js';
import { createGuards } from './auth/guards.js';
import { authRoutes } from './modules/auth.js';
import { adminRoutes } from './modules/admin.js';
import { devicesRoutes } from './modules/devices.js';
import { eventsRoutes } from './modules/events.js';
import { membershipRoutes } from './modules/membership.js';
import { passesRoutes } from './modules/passes.js';
import { postsRoutes } from './modules/posts.js';
import { profileRoutes } from './modules/profile.js';
import { universitiesRoutes } from './modules/universities.js';
import { notificationsRoutes } from './modules/notifications.js';
import type { Mailer } from './mail/mailer.js';
import { albumsRoutes } from './modules/albums.js';
import { cardRoutes } from './modules/card.js';
import { lostFoundRoutes } from './modules/lostFound.js';
import { booksRoutes } from './modules/books.js';
import { cvRoutes } from './modules/cv.js';
import { groupsRoutes } from './modules/groups.js';
import { jobsRoutes } from './modules/jobs.js';
import { mediaRoutes } from './modules/media.js';
import { notesRoutes } from './modules/notes.js';
import { reportsRoutes } from './modules/reports.js';
import { chatRoutes } from './modules/chat.js';
import { storiesRoutes } from './modules/stories.js';
import { chatGroupsRoutes } from './modules/chatGroups.js';
import { realtimeRoutes } from './modules/realtime.js';
import { RealtimeHub } from './realtime/hub.js';
import { societiesRoutes } from './modules/societies.js';
import type { Storage } from './storage/index.js';
import { passwordAuthRoutes } from './modules/passwordAuth.js';
import type { PushProvider } from './push/index.js';
import { Notifier } from './push/notifier.js';

export interface Deps {
  config: Config;
  pool: pg.Pool;
  push: PushProvider;
  mailer: Mailer;
  storage: Storage;
  /** Who is connected over the live connection (chat nudges). */
  hub: RealtimeHub;
}

export async function buildApp(base: Omit<Deps, 'hub'> & { hub?: RealtimeHub }): Promise<FastifyInstance> {
  // Every notification is saved to the inbox before it is pushed.
  const deps: Deps = { ...base, push: new Notifier(base.pool, base.push), hub: base.hub ?? new RealtimeHub() };
  const { config, pool } = deps;
  const app = Fastify({
    logger: config.nodeEnv === 'test' ? false : { level: config.nodeEnv === 'production' ? 'info' : 'debug' },
    trustProxy: true,
    bodyLimit: 1_000_000,
  });

  // An empty body labelled as JSON (common for PUT/DELETE without data) is simply "no body", not an error.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '' || body === undefined) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(Object.assign(new Error('The request body is not valid JSON.'), { statusCode: 400 }), undefined);
    }
  });

  await app.register(helmet);
  // The admin web page runs in a browser, which asks permission first for anything but GET/POST. The default of the
  // plugin allows only GET, HEAD and POST, so editing or deleting from the dashboard was refused.
  await app.register(cors, {
    origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(','),
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  // Generous global limit; the sign-in routes set a much stricter one.
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'validation_failed', message: 'Some fields are not valid.', details: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })) },
      });
    }
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.status(413).send({ error: { code: 'file_too_large', message: 'That photo is larger than 10 MB. Choose a smaller one.' } });
    }
    if (e.statusCode === 429) {
      return reply.status(429).send({ error: { code: 'rate_limited', message: 'Too many requests. Please wait a moment.' } });
    }
    // PostgreSQL: invalid uuid / invalid text representation => the id cannot exist.
    if (e.code === '22P02') {
      return reply.status(404).send({ error: { code: 'not_found', message: 'Not found.' } });
    }
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: 'bad_request', message: e.message } });
    }
    req.log.error({ err }, 'Unhandled error');
    return reply.status(500).send({ error: { code: 'internal', message: 'Something went wrong on our side.' } });
  });

  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'not_found', message: 'Not found.' } }));

  app.get('/health', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      return reply.status(503).send({ status: 'database_unavailable' });
    }
  });

  const guards = createGuards(deps);
  await app.register(
    async v1 => {
      await v1.register(authRoutes, { deps, guards });
      await v1.register(passwordAuthRoutes, { deps, guards });
      await v1.register(profileRoutes, { deps, guards });
      await v1.register(universitiesRoutes, { deps, guards });
      await v1.register(membershipRoutes, { deps, guards });
      await v1.register(adminRoutes, { deps, guards });
      await v1.register(postsRoutes, { deps, guards });
      await v1.register(eventsRoutes, { deps, guards });
      await v1.register(societiesRoutes, { deps, guards });
      await v1.register(albumsRoutes, { deps, guards });
      await v1.register(lostFoundRoutes, { deps, guards });
      await v1.register(cardRoutes, { deps, guards });
      await v1.register(mediaRoutes, { deps, guards });
      await v1.register(notesRoutes, { deps, guards });
      await v1.register(booksRoutes, { deps, guards });
      await v1.register(groupsRoutes, { deps, guards });
      await v1.register(jobsRoutes, { deps, guards });
      await v1.register(cvRoutes, { deps, guards });
      await v1.register(reportsRoutes, { deps, guards });
      await v1.register(chatRoutes, { deps, guards });
      await v1.register(chatGroupsRoutes, { deps, guards });
      await v1.register(storiesRoutes, { deps, guards });
      await v1.register(realtimeRoutes, { deps, guards });
      await v1.register(passesRoutes, { deps, guards });
      await v1.register(devicesRoutes, { deps, guards });
      await v1.register(notificationsRoutes, { deps, guards });
    },
    { prefix: '/v1' },
  );

  return app;
}
