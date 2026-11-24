import { z } from 'zod';

import { ADMIN_ROLES } from '../domain.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { ms, parse, uuid } from '../lib/http.js';
import type { Routes } from './types.js';

interface ItemRow {
  id: string;
  created_by: string;
  creator_name: string;
  kind: 'lost' | 'found';
  title: string;
  description: string;
  place: string;
  status: 'open' | 'resolved';
  created_at: Date;
  resolved_at: Date | null;
  claim_count: number;
  i_replied: boolean;
}

const SELECT = `
  SELECT i.*, u.name AS creator_name,
    (SELECT count(*)::int FROM lost_claims c WHERE c.item_id = i.id) AS claim_count,
    EXISTS (SELECT 1 FROM lost_claims c WHERE c.item_id = i.id AND c.user_id = $2) AS i_replied
  FROM lost_items i JOIN users u ON u.id = i.created_by`;

export const lostFoundRoutes: Routes = async (app, { deps, guards }) => {
  const { pool, push } = deps;
  const member = { preHandler: guards.member };

  const dto = (i: ItemRow, viewerId: string, isAdmin: boolean) => ({
    id: i.id,
    kind: i.kind,
    title: i.title,
    description: i.description,
    place: i.place,
    status: i.status,
    postedBy: i.creator_name,
    mine: i.created_by === viewerId,
    canManage: i.created_by === viewerId || isAdmin,
    // Only the poster (and admins) see how many people replied.
    replies: i.created_by === viewerId || isAdmin ? i.claim_count : null,
    iReplied: i.i_replied,
    createdAt: ms(i.created_at),
    resolvedAt: ms(i.resolved_at),
  });

  async function load(id: string, universityId: string, viewerId: string): Promise<ItemRow> {
    const { rows } = await pool.query<ItemRow>(`${SELECT} WHERE i.id = $1 AND i.university_id = $3`, [id, viewerId, universityId]);
    if (!rows[0]) {
      throw notFound('Item not found.');
    }
    return rows[0];
  }

  app.get<{ Querystring: { status?: string } }>('/lost-found', member, async req => {
    const m = req.member!;
    const status = parse(z.enum(['open', 'resolved', 'all']).default('open'), req.query.status);
    const { rows } = await pool.query<ItemRow>(
      `${SELECT} WHERE i.university_id = $1 AND ($3 = 'all' OR i.status = $3) ORDER BY i.created_at DESC LIMIT 100`,
      [m.universityId, m.userId, status],
    );
    const isAdmin = ADMIN_ROLES.includes(m.role);
    return { items: rows.map(r => dto(r, m.userId, isAdmin)) };
  });

  app.post('/lost-found', { preHandler: guards.member, config: { rateLimit: { max: deps.config.nodeEnv === 'test' ? 100_000 : 15, timeWindow: '1 hour' } } }, async (req, reply) => {
    const m = req.member!;
    const b = parse(
      z.object({
        kind: z.enum(['lost', 'found']),
        title: z.string().trim().min(3).max(80),
        description: z.string().trim().max(500).default(''),
        place: z.string().trim().max(80).default(''),
      }),
      req.body,
    );
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO lost_items (university_id, created_by, kind, title, description, place) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [m.universityId, m.userId, b.kind, b.title, b.description, b.place],
    );
    return reply.status(201).send(dto(await load((rows[0] as { id: string }).id, m.universityId, m.userId), m.userId, ADMIN_ROLES.includes(m.role)));
  });

  // "I found it" / "this is mine": tells the poster. One reply per person per item.
  app.post<{ Params: { id: string } }>('/lost-found/:id/reply', { preHandler: guards.member, config: { rateLimit: { max: deps.config.nodeEnv === 'test' ? 100_000 : 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    const m = req.member!;
    const item = await load(uuid(req.params.id), m.universityId, m.userId);
    if (item.created_by === m.userId) {
      throw forbidden('This is your own post.');
    }
    if (item.status !== 'open') {
      throw conflict('This item is already resolved.', 'already_resolved');
    }
    const ins = await pool.query('INSERT INTO lost_claims (item_id, university_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [item.id, m.universityId, m.userId]);
    if (ins.rowCount) {
      await push.sendToUsers([item.created_by], {
        title: item.kind === 'lost' ? 'Someone may have found your item' : 'Someone says this is theirs',
        body: `${req.user!.name} replied about "${item.title}". Open Lost & Found to see who.`,
        data: { kind: 'official' },
      });
    }
    return reply.status(200).send({ ok: true });
  });

  // The poster (and admins) can see who replied, to get in touch.
  app.get<{ Params: { id: string } }>('/lost-found/:id/replies', member, async req => {
    const m = req.member!;
    const item = await load(uuid(req.params.id), m.universityId, m.userId);
    if (item.created_by !== m.userId && !ADMIN_ROLES.includes(m.role)) {
      throw forbidden();
    }
    const { rows } = await pool.query<{ id: string; name: string; department: string; batch: string; created_at: Date }>(
      `SELECT u.id, u.name, mem.department, mem.batch, c.created_at
         FROM lost_claims c JOIN users u ON u.id = c.user_id JOIN memberships mem ON mem.user_id = c.user_id
        WHERE c.item_id = $1 ORDER BY c.created_at`,
      [item.id],
    );
    return { replies: rows.map(r => ({ uid: r.id, name: r.name, department: r.department, batch: r.batch, createdAt: ms(r.created_at) })) };
  });

  app.post<{ Params: { id: string } }>('/lost-found/:id/resolve', member, async req => {
    const m = req.member!;
    const item = await load(uuid(req.params.id), m.universityId, m.userId);
    if (item.created_by !== m.userId && !ADMIN_ROLES.includes(m.role)) {
      throw forbidden('Only the person who posted this (or an admin) can close it.');
    }
    await pool.query("UPDATE lost_items SET status = 'resolved', resolved_at = COALESCE(resolved_at, now()) WHERE id = $1", [item.id]);
    return dto(await load(item.id, m.universityId, m.userId), m.userId, ADMIN_ROLES.includes(m.role));
  });

  app.delete<{ Params: { id: string } }>('/lost-found/:id', member, async (req, reply) => {
    const m = req.member!;
    const item = await load(uuid(req.params.id), m.universityId, m.userId);
    if (item.created_by !== m.userId && !ADMIN_ROLES.includes(m.role)) {
      throw forbidden('Only the person who posted this (or an admin) can delete it.');
    }
    await pool.query('DELETE FROM lost_items WHERE id = $1', [item.id]);
    return reply.status(204).send();
  });
};
