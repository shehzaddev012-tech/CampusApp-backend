import { ms, uuid } from '../lib/http.js';
import type { Routes } from './types.js';

interface Row {
  id: string;
  kind: string;
  title: string;
  body: string;
  post_id: string | null;
  event_id: string | null;
  created_at: Date;
  read_at: Date | null;
}

const dto = (n: Row) => ({
  id: n.id,
  kind: n.kind,
  title: n.title,
  body: n.body,
  postId: n.post_id ?? undefined,
  eventId: n.event_id ?? undefined,
  createdAt: ms(n.created_at),
  read: n.read_at !== null,
});

export const notificationsRoutes: Routes = async (app, { deps, guards }) => {
  const { pool } = deps;
  const auth = { preHandler: guards.user };

  // My inbox, newest first, with how many are unread.
  app.get('/notifications', auth, async req => {
    const id = req.user!.id;
    const [list, unread] = await Promise.all([
      pool.query<Row>('SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [id]),
      pool.query<{ n: number }>('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [id]),
    ]);
    return { notifications: list.rows.map(dto), unread: unread.rows[0]?.n ?? 0 };
  });

  app.post('/notifications/read-all', auth, async (req, reply) => {
    await pool.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user!.id]);
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>('/notifications/:id/read', auth, async (req, reply) => {
    await pool.query('UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL', [uuid(req.params.id), req.user!.id]);
    return reply.status(204).send();
  });
};
