import { z } from 'zod';

import { ADMIN_ROLES } from '../domain.js';
import { withTx } from '../db/pool.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { ms, parse, uuid } from '../lib/http.js';
import type { Routes } from './types.js';

interface GroupRow {
  id: string;
  title: string;
  course: string;
  description: string;
  meeting: string;
  capacity: number | null;
  status: string;
  created_by: string;
  creator_name: string;
  created_at: Date;
  member_count: number;
  joined: boolean;
}

const SELECT = `
  SELECT g.id, g.title, g.course, g.description, g.meeting, g.capacity, g.status, g.created_by, u.name AS creator_name, g.created_at,
    (SELECT count(*)::int FROM study_group_members m WHERE m.group_id = g.id) AS member_count,
    EXISTS (SELECT 1 FROM study_group_members m WHERE m.group_id = g.id AND m.user_id = $2) AS joined
  FROM study_groups g JOIN users u ON u.id = g.created_by`;

const likeEscape = (s: string) => s.replace(/[\\%_]/g, c => `\\${c}`);

export const groupsRoutes: Routes = async (app, { deps, guards }) => {
  const { config, pool, push } = deps;
  const member = { preHandler: guards.member };

  const dto = (g: GroupRow, viewerId: string, isAdmin: boolean) => ({
    id: g.id,
    title: g.title,
    course: g.course,
    description: g.description,
    meeting: g.meeting,
    capacity: g.capacity,
    memberCount: g.member_count,
    full: g.capacity !== null && g.member_count >= g.capacity,
    status: g.status,
    createdByName: g.creator_name,
    mine: g.created_by === viewerId,
    canManage: g.created_by === viewerId || isAdmin,
    joined: g.joined,
    createdAt: ms(g.created_at),
  });

  async function load(id: string, universityId: string, viewerId: string): Promise<GroupRow> {
    const { rows } = await pool.query<GroupRow>(`${SELECT} WHERE g.id = $1 AND g.university_id = $3`, [id, viewerId, universityId]);
    if (!rows[0]) {
      throw notFound('Study group not found.');
    }
    return rows[0];
  }

  app.get<{ Querystring: { q?: string; scope?: string } }>('/study-groups', member, async req => {
    const m = req.member!;
    const q = parse(z.object({ q: z.string().trim().max(60).optional(), scope: z.enum(['open', 'mine']).default('open') }), req.query);
    const { rows } = await pool.query<GroupRow>(
      `${SELECT}
        WHERE g.university_id = $1
          AND (($3 = 'open' AND g.status = 'open') OR ($3 = 'mine' AND (g.created_by = $2 OR EXISTS (SELECT 1 FROM study_group_members x WHERE x.group_id = g.id AND x.user_id = $2))))
          AND ($4::text IS NULL OR g.title ILIKE $4 OR g.course ILIKE $4)
        ORDER BY g.created_at DESC LIMIT 100`,
      [m.universityId, m.userId, q.scope, q.q ? `%${likeEscape(q.q)}%` : null],
    );
    return { groups: rows.map(g => dto(g, m.userId, ADMIN_ROLES.includes(m.role))) };
  });

  app.get<{ Params: { id: string } }>('/study-groups/:id', member, async req => {
    const m = req.member!;
    const g = await load(uuid(req.params.id), m.universityId, m.userId);
    const members = await pool.query<{ id: string; name: string; department: string; batch: string; joined_at: Date }>(
      `SELECT u.id, u.name, mem.department, mem.batch, x.joined_at
         FROM study_group_members x JOIN users u ON u.id = x.user_id JOIN memberships mem ON mem.user_id = x.user_id
        WHERE x.group_id = $1 ORDER BY x.joined_at`,
      [g.id],
    );
    return { ...dto(g, m.userId, ADMIN_ROLES.includes(m.role)), members: members.rows.map(r => ({ uid: r.id, name: r.name, department: r.department, batch: r.batch, isCreator: r.id === g.created_by })) };
  });

  app.post('/study-groups', { preHandler: guards.member, config: { rateLimit: { max: config.nodeEnv === 'test' ? 100_000 : 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const m = req.member!;
    const b = parse(
      z.object({
        title: z.string().trim().min(3).max(80),
        course: z.string().trim().max(60).default(''),
        description: z.string().trim().max(300).default(''),
        meeting: z.string().trim().max(100).default(''),
        capacity: z.number().int().min(2).max(50).nullable().default(null),
      }),
      req.body,
    );
    const id = await withTx(pool, async c => {
      const ins = await c.query<{ id: string }>(
        'INSERT INTO study_groups (university_id, created_by, title, course, description, meeting, capacity) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
        [m.universityId, m.userId, b.title, b.course, b.description, b.meeting, b.capacity],
      );
      const gid = (ins.rows[0] as { id: string }).id;
      await c.query('INSERT INTO study_group_members (group_id, university_id, user_id) VALUES ($1, $2, $3)', [gid, m.universityId, m.userId]);
      return gid;
    });
    return reply.status(201).send(dto(await load(id, m.universityId, m.userId), m.userId, false));
  });

  // The group row is locked while someone joins, so the last seat can never go to two people.
  app.put<{ Params: { id: string } }>('/study-groups/:id/join', member, async req => {
    const m = req.member!;
    const gid = uuid(req.params.id);
    await withTx(pool, async c => {
      const g = await c.query<{ capacity: number | null; status: string }>('SELECT capacity, status FROM study_groups WHERE id = $1 AND university_id = $2 FOR UPDATE', [gid, m.universityId]);
      const group = g.rows[0];
      if (!group) {
        throw notFound('Study group not found.');
      }
      const already = await c.query('SELECT 1 FROM study_group_members WHERE group_id = $1 AND user_id = $2', [gid, m.userId]);
      if (already.rowCount) {
        return;
      }
      if (group.status !== 'open') {
        throw conflict('This group is closed.', 'group_closed');
      }
      const count = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM study_group_members WHERE group_id = $1', [gid]);
      if (group.capacity !== null && (count.rows[0]?.n ?? 0) >= group.capacity) {
        throw conflict('This group is full.', 'group_full');
      }
      await c.query('INSERT INTO study_group_members (group_id, university_id, user_id) VALUES ($1, $2, $3)', [gid, m.universityId, m.userId]);
    });
    const g = await load(gid, m.universityId, m.userId);
    await push.sendToUsers([g.created_by].filter(id => id !== m.userId), { title: 'Someone joined your study group', body: `${req.user!.name} joined "${g.title}".`, data: { kind: 'official' } });
    return dto(g, m.userId, ADMIN_ROLES.includes(m.role));
  });

  app.delete<{ Params: { id: string } }>('/study-groups/:id/join', member, async req => {
    const m = req.member!;
    const g = await load(uuid(req.params.id), m.universityId, m.userId);
    if (g.created_by === m.userId) {
      throw conflict('You started this group. Close it instead of leaving.', 'creator_cannot_leave');
    }
    await pool.query('DELETE FROM study_group_members WHERE group_id = $1 AND user_id = $2', [g.id, m.userId]);
    return dto(await load(g.id, m.universityId, m.userId), m.userId, ADMIN_ROLES.includes(m.role));
  });

  app.patch<{ Params: { id: string } }>('/study-groups/:id', member, async req => {
    const m = req.member!;
    const isAdmin = ADMIN_ROLES.includes(m.role);
    const b = parse(z.object({ status: z.enum(['open', 'closed']).optional(), meeting: z.string().trim().max(100).optional(), description: z.string().trim().max(300).optional() }), req.body);
    const g = await load(uuid(req.params.id), m.universityId, m.userId);
    if (g.created_by !== m.userId && !isAdmin) {
      throw forbidden('Only the person who started this group (or an admin) can change it.');
    }
    await pool.query('UPDATE study_groups SET status = COALESCE($2, status), meeting = COALESCE($3, meeting), description = COALESCE($4, description) WHERE id = $1', [g.id, b.status ?? null, b.meeting ?? null, b.description ?? null]);
    return dto(await load(g.id, m.universityId, m.userId), m.userId, isAdmin);
  });

  app.delete<{ Params: { id: string } }>('/study-groups/:id', member, async (req, reply) => {
    const m = req.member!;
    const g = await load(uuid(req.params.id), m.universityId, m.userId);
    if (g.created_by !== m.userId && !ADMIN_ROLES.includes(m.role)) {
      throw forbidden('Only the person who started this group (or an admin) can delete it.');
    }
    await pool.query('DELETE FROM study_groups WHERE id = $1', [g.id]);
    return reply.status(204).send();
  });
};
