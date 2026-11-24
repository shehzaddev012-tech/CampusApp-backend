import websocket from '@fastify/websocket';

import { verifyAccessToken } from '../auth/tokens.js';
import { audienceOf, findAccessible } from './chat.js';
import type { Routes } from './types.js';

const AUTH_DEADLINE_MS = 10_000;
const HEARTBEAT_MS = 30_000;
const TYPING_EVERY_MS = 1500;

/**
 * GET /v1/ws  (WebSocket). The first message must be {"type":"auth","token":"<access token>"} within 10 seconds
 * (the token is not put in the address, where logs could keep it). The server then answers {"type":"ready"} and
 * sends nudges like {"type":"chat","conversationId":"..."}. The connection is closed when the token would expire,
 * and the app reconnects with a fresh one.
 *
 * After signing in the app may send {"type":"typing","conversationId":"..."} while someone is typing; the other
 * people in that chat get {"type":"typing","conversationId":"...","name":"..."}. The server checks the sender is
 * really in that conversation, and sends at most one every 1.5 seconds per person.
 */
export const realtimeRoutes: Routes = async (app, { deps }) => {
  const { config, pool, hub } = deps;
  await app.register(websocket, { options: { maxPayload: 4096 } });

  app.get('/ws', { websocket: true }, socket => {
    let userId: string | null = null;
    let universityId = '';
    let name = '';
    let checking = false;
    let alive = true;
    let lastTyping = 0;

    const deadline = setTimeout(() => socket.close(4401, 'Sign in required'), AUTH_DEADLINE_MS);
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, HEARTBEAT_MS);
    let lifetime: NodeJS.Timeout | null = null;
    socket.on('pong', () => {
      alive = true;
    });

    const signIn = async (raw: string) => {
      const msg = JSON.parse(raw) as { type?: string; token?: unknown };
      if (msg.type !== 'auth' || typeof msg.token !== 'string') {
        throw new Error('first message must be auth');
      }
      const uid = await verifyAccessToken(config, msg.token);
      const active = await pool.query<{ university_id: string; name: string }>(
        "SELECT m.university_id, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.user_id = $1 AND m.status = 'active'",
        [uid],
      );
      if (!active.rows[0]) {
        socket.close(4403, 'Not an active member');
        return;
      }
      if (!hub.add(uid, socket)) {
        socket.close(4429, 'Too many connections');
        return;
      }
      userId = uid;
      universityId = active.rows[0].university_id;
      name = active.rows[0].name;
      clearTimeout(deadline);
      lifetime = setTimeout(() => socket.close(4408, 'Renew your session'), Math.max(60, config.accessTtlSeconds - 30) * 1000);
      socket.send(JSON.stringify({ type: 'ready' }));
    };

    const typing = async (raw: string) => {
      const msg = JSON.parse(raw) as { type?: string; conversationId?: unknown };
      const now = Date.now();
      if (msg.type !== 'typing' || typeof msg.conversationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(msg.conversationId) || now - lastTyping < TYPING_EVERY_MS || !userId) {
        return;
      }
      lastTyping = now;
      const conv = await findAccessible(pool, msg.conversationId, universityId, userId);
      if (!conv) {
        return;
      }
      hub.notify(await audienceOf(pool, conv, userId), { type: 'typing', conversationId: conv.id, name });
    };

    socket.on('message', raw => {
      alive = true;
      const text = raw.toString();
      if (userId) {
        void typing(text).catch(() => undefined);
        return;
      }
      if (checking) {
        return;
      }
      checking = true;
      void signIn(text)
        .catch(() => socket.close(4401, 'Sign in required'))
        .finally(() => {
          checking = false;
        });
    });

    socket.on('close', () => {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      if (lifetime) {
        clearTimeout(lifetime);
      }
      if (userId && hub.remove(userId, socket)) {
        // That was their last connection: remember when they were last around.
        void pool
          .query('INSERT INTO user_presence (user_id, last_seen_at) VALUES ($1, now()) ON CONFLICT (user_id) DO UPDATE SET last_seen_at = now()', [userId])
          .catch(() => undefined);
      }
    });
    socket.on('error', () => socket.terminate());
  });
};
