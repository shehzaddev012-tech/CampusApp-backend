import { z } from 'zod';

import { parse } from '../lib/http.js';
import type { Routes } from './types.js';

export const devicesRoutes: Routes = async (app, { deps, guards }) => {
  const { pool } = deps;

  // Register this phone for push notifications. A token that moves to another account moves with it.
  app.put('/devices', { preHandler: guards.user }, async (req, reply) => {
    const body = parse(z.object({ token: z.string().min(20).max(4096), platform: z.enum(['android', 'ios']).default('android') }), req.body);
    await pool.query(
      `INSERT INTO devices (token, user_id, platform) VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, updated_at = now()`,
      [body.token, req.user!.id, body.platform],
    );
    return reply.status(204).send();
  });

  app.delete<{ Params: { token: string } }>('/devices/:token', { preHandler: guards.user }, async (req, reply) => {
    await pool.query('DELETE FROM devices WHERE token = $1 AND user_id = $2', [req.params.token, req.user!.id]);
    return reply.status(204).send();
  });
};
