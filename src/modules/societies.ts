import { z } from 'zod';

import { ADMIN_ROLES, EVENT_CATEGORIES, type Role } from '../domain.js';
import { withTx, type Db } from '../db/pool.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { ms, parse, uuid } from '../lib/http.js';
import { EVENT_SELECT, eventDto } from './events.js';
import type { Routes } from './types.js';

interface SocietyRow {
  id: string;
  university_id: string;
  name: string;
  about: string;
  category: string;
  created_at: Date;
  member_count: number;
  my_role: 'member' | 'head' | null;
  next_event: { id: string; title: string; startsAt: number } | null;
}

/** A society of MY university with its live counters, and my own place in it. */
const SELECT = `
  SELECT s.id, s.university_id, s.name, s.about, s.category, s.created_at,
    (SELECT count(*)::int FROM society_members sm WHERE sm.society_id = s.id) AS member_count,
    (SELECT sm.role FROM society_members sm WHERE sm.society_id = s.id AND sm.user_id = $2) AS my_role,
    (SELECT json_build_object('id', e.id, 'title', e.title, 'startsAt', (extract(epoch FROM e.starts_at) * 1000)::bigint)
       FROM events e WHERE e.society_id = s.id AND e.ends_at >= now() ORDER BY e.starts_at LIMIT 1) AS next_event
  FROM societies s`;

const dto = (s: SocietyRow) => ({
  id: s.id,
  name: s.name,
  about: s.about,
  category: s.category,
  memberCount: s.member_count,
  myRole: s.my_role,
  joined: s.my_role !== null,
  nextEvent: s.next_event ? { id: s.next_event.id, title: s.next_event.title, startsAt: Number(s.next_event.startsAt) } : null,
  createdAt: ms(s.created_at),
});

async function loadSociety(db: Db, id: string, universityId: string, userId: string): Promise<SocietyRow> {
  const { rows } = await db.query<SocietyRow>(`${SELECT} WHERE s.id = $1 AND s.university_id = $3`, [id, userId, universityId]);
  if (!rows[0]) {
    throw notFound('Society not found.');
  }
  return rows[0];
}

/** True when this person may manage the society: a university admin, or one of its heads. */
export async function canManageSociety(db: Db, societyId: string, universityId: string, userId: string, role: Role): Promise<boolean> {
  if (ADMIN_ROLES.includes(role)) {
    const own = await db.query('SELECT 1 FROM societies WHERE id = $1 AND university_id = $2', [societyId, universityId]);
    return own.rowCount === 1;
  }
  const head = await db.query("SELECT 1 FROM society_members WHERE society_id = $1 AND university_id = $2 AND user_id = $3 AND role = 'head'", [societyId, universityId, userId]);
  return head.rowCount === 1;
}

/** Someone who heads no society any more stops being a society head. */
async function demoteIfNoSociety(db: Db, userIds: string[]) {
  if (userIds.length === 0) {
    return;
  }
  await db.query(
    `UPDATE memberships SET role = 'student'
      WHERE user_id = ANY($1::uuid[]) AND role = 'society_head'
        AND NOT EXISTS (SELECT 1 FROM society_members sm WHERE sm.user_id = memberships.user_id AND sm.role = 'head')`,
    [userIds],
  );
}

const fields = {
  name: z.string().trim().min(2).max(80),
  about: z.string().trim().max(500),
  category: z.enum(EVENT_CATEGORIES),
};

export const societiesRoutes: Routes = async (app, { deps, guards }) => {
  const { pool, push } = deps;
  const member = { preHandler: guards.member };
  const admin = { preHandler: guards.roles(...ADMIN_ROLES) };

  app.get('/societies', member, async req => {
    const m = req.member!;
    const { rows } = await pool.query<SocietyRow>(`${SELECT} WHERE s.university_id = $1 ORDER BY member_count DESC, s.name`, [m.universityId, m.userId]);
    return { societies: rows.map(dto) };
  });

  app.post('/societies', admin, async (req, reply) => {
    const m = req.member!;
    const body = parse(z.object({ name: fields.name, about: fields.about.default(''), category: fields.category }), req.body);
    try {
      const { rows } = await pool.query<{ id: string }>(
        'INSERT INTO societies (university_id, name, about, category, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [m.universityId, body.name, body.about, body.category, m.userId],
      );
      return reply.status(201).send(dto(await loadSociety(pool, (rows[0] as { id: string }).id, m.universityId, m.userId)));
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw conflict('A society with this name already exists.', 'society_name_taken');
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/societies/:id', member, async req => {
    const m = req.member!;
    const id = uuid(req.params.id);
    const society = await loadSociety(pool, id, m.universityId, m.userId);
    const [heads, events, posts] = await Promise.all([
      pool.query<{ id: string; name: string; photo_url: string | null }>(
        `SELECT u.id, u.name, u.photo_url FROM society_members sm JOIN users u ON u.id = sm.user_id
          WHERE sm.society_id = $1 AND sm.role = 'head' ORDER BY sm.joined_at`,
        [id],
      ),
      pool.query(`${EVENT_SELECT} WHERE e.society_id = $1 AND e.university_id = $2 AND e.ends_at >= now() ORDER BY e.starts_at LIMIT 5`, [id, m.universityId]),
      pool.query<{ id: string; title: string; created_at: Date }>(
        'SELECT id, title, created_at FROM posts WHERE society_id = $1 AND university_id = $2 ORDER BY created_at DESC LIMIT 5',
        [id, m.universityId],
      ),
    ]);
    return {
      ...dto(society),
      heads: heads.rows.map(h => ({ uid: h.id, name: h.name, photoUrl: h.photo_url })),
      upcomingEvents: events.rows.map(r => eventDto(r as never)),
      recentPosts: posts.rows.map(p => ({ id: p.id, title: p.title, createdAt: ms(p.created_at) })),
    };
  });

  app.get<{ Params: { id: string } }>('/societies/:id/members', member, async req => {
    const m = req.member!;
    const id = uuid(req.params.id);
    await loadSociety(pool, id, m.universityId, m.userId);
    const { rows } = await pool.query<{ id: string; name: string; photo_url: string | null; role: string; joined_at: Date }>(
      `SELECT u.id, u.name, u.photo_url, sm.role, sm.joined_at
         FROM society_members sm JOIN users u ON u.id = sm.user_id
        WHERE sm.society_id = $1 ORDER BY (sm.role = 'head') DESC, sm.joined_at LIMIT 200`,
      [id],
    );
    return { members: rows.map(r => ({ uid: r.id, name: r.name, photoUrl: r.photo_url, role: r.role, joinedAt: ms(r.joined_at) })) };
  });

  app.patch<{ Params: { id: string } }>('/societies/:id', member, async req => {
    const m = req.member!;
    const id = uuid(req.params.id);
    const body = parse(z.object({ name: fields.name.optional(), about: fields.about.optional(), category: fields.category.optional() }), req.body);
    if (!(await canManageSociety(pool, id, m.universityId, m.userId, m.role))) {
      throw forbidden('Only the society head or an admin can edit this society.');
    }
    try {
      await pool.query(
        `UPDATE societies SET name = COALESCE($3, name), about = COALESCE($4, about), category = COALESCE($5, category)
          WHERE id = $1 AND university_id = $2`,
        [id, m.universityId, body.name ?? null, body.about ?? null, body.category ?? null],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw conflict('A society with this name already exists.', 'society_name_taken');
      }
      throw err;
    }
    return dto(await loadSociety(pool, id, m.universityId, m.userId));
  });

  app.delete<{ Params: { id: string } }>('/societies/:id', admin, async (req, reply) => {
    const m = req.member!;
    const id = uuid(req.params.id);
    await withTx(pool, async c => {
      const heads = await c.query<{ user_id: string }>("SELECT user_id FROM society_members WHERE society_id = $1 AND role = 'head'", [id]);
      const gone = await c.query('DELETE FROM societies WHERE id = $1 AND university_id = $2', [id, m.universityId]);
      if (!gone.rowCount) {
        throw notFound('Society not found.');
      }
      await demoteIfNoSociety(c, heads.rows.map(h => h.user_id));
    });
    return reply.status(204).send();
  });

  app.put<{ Params: { id: string } }>('/societies/:id/join', member, async (req, reply) => {
    const m = req.member!;
    const id = uuid(req.params.id);
    await loadSociety(pool, id, m.universityId, m.userId);
    await pool.query('INSERT INTO society_members (society_id, user_id, university_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, m.userId, m.universityId]);
    return reply.status(200).send(dto(await loadSociety(pool, id, m.universityId, m.userId)));
  });

  app.delete<{ Params: { id: string } }>('/societies/:id/join', member, async (req, reply) => {
    const m = req.member!;
    const id = uuid(req.params.id);
    await loadSociety(pool, id, m.universityId, m.userId);
    await withTx(pool, async c => {
      await c.query('DELETE FROM society_members WHERE society_id = $1 AND user_id = $2', [id, m.userId]);
      await demoteIfNoSociety(c, [m.userId]);
    });
    return reply.status(200).send(dto(await loadSociety(pool, id, m.universityId, m.userId)));
  });

  // Admin: make someone a head of this society. They also become a member, and get the society-head role.
  app.put<{ Params: { id: string; userId: string } }>('/societies/:id/heads/:userId', admin, async (req, reply) => {
    const m = req.member!;
    const id = uuid(req.params.id);
    const userId = uuid(req.params.userId);
    const society = await loadSociety(pool, id, m.universityId, m.userId);
    await withTx(pool, async c => {
      const target = await c.query<{ role: Role }>("SELECT role FROM memberships WHERE user_id = $1 AND university_id = $2 AND status = 'active' FOR UPDATE", [userId, m.universityId]);
      if (!target.rows[0]) {
        throw notFound('That person is not an approved member of this university.');
      }
      await c.query(
        `INSERT INTO society_members (society_id, user_id, university_id, role) VALUES ($1, $2, $3, 'head')
         ON CONFLICT (society_id, user_id) DO UPDATE SET role = 'head'`,
        [id, userId, m.universityId],
      );
      if (target.rows[0].role === 'student') {
        await c.query("UPDATE memberships SET role = 'society_head' WHERE user_id = $1", [userId]);
      }
    });
    await push.sendToUsers([userId], { title: 'You are now a society head', body: `You can now post updates, create events and add photos for ${society.name}.`, data: { kind: 'society' } });
    return reply.status(200).send({ ok: true });
  });

  app.delete<{ Params: { id: string; userId: string } }>('/societies/:id/heads/:userId', admin, async (req, reply) => {
    const m = req.member!;
    const id = uuid(req.params.id);
    const userId = uuid(req.params.userId);
    await loadSociety(pool, id, m.universityId, m.userId);
    await withTx(pool, async c => {
      await c.query("UPDATE society_members SET role = 'member' WHERE society_id = $1 AND user_id = $2 AND role = 'head'", [id, userId]);
      await demoteIfNoSociety(c, [userId]);
    });
    return reply.status(200).send({ ok: true });
  });
};
