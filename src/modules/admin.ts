import { z } from 'zod';

import { ADMIN_ROLES, MEMBER_STATUSES, ROLES } from '../domain.js';
import { forbidden, notFound } from '../lib/errors.js';
import { ms, parse, uuid } from '../lib/http.js';
import type { Routes } from './types.js';

interface Row {
  user_id: string;
  name: string;
  email: string;
  photo_url: string | null;
  student_id: string;
  department: string;
  batch: string;
  role: string;
  status: string;
  created_at: Date;
}

const dto = (r: Row) => ({
  uid: r.user_id,
  name: r.name,
  email: r.email,
  photoUrl: r.photo_url,
  studentId: r.student_id,
  department: r.department,
  batch: r.batch,
  role: r.role,
  status: r.status,
  createdAt: ms(r.created_at),
});

const SELECT = `
  SELECT m.user_id, u.name, u.email, u.photo_url, m.student_id, m.department, m.batch, m.role, m.status, m.created_at
    FROM memberships m JOIN users u ON u.id = m.user_id`;

export const adminRoutes: Routes = async (app, { deps, guards }) => {
  const { pool, push } = deps;
  const admins = { preHandler: guards.roles(...ADMIN_ROLES) };

  // Members of my university.
  app.get<{ Querystring: { status?: string } }>('/admin/members', admins, async req => {
    const m = req.member!;
    const status = parse(z.enum(MEMBER_STATUSES).optional(), req.query.status);
    const params: unknown[] = [m.universityId];
    let where = 'WHERE m.university_id = $1';
    if (status) {
      params.push(status);
      where += ` AND m.status = $${params.length}`;
    }
    const { rows } = await pool.query<Row>(`${SELECT} ${where} ORDER BY m.created_at DESC LIMIT 500`, params);
    return { members: rows.map(dto) };
  });

  // Numbers for the admin dashboard. Everything is counted inside the admin's own university.
  app.get('/admin/stats', admins, async req => {
    const m = req.member!;
    const u = m.universityId;
    const one = async <T,>(sql: string): Promise<T> => (await pool.query(sql, [u])).rows[0] as T;
    const [members, content, events, byDept, recent, topSocieties] = await Promise.all([
      one<{ active: number; pending: number; suspended: number; new30: number }>(
        `SELECT count(*) FILTER (WHERE status = 'active')::int AS active, count(*) FILTER (WHERE status = 'pending')::int AS pending,
                count(*) FILTER (WHERE status = 'suspended')::int AS suspended, count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS new30
           FROM memberships WHERE university_id = $1`),
      one<{ posts30: number; reports_open: number; jobs_open: number; lost_open: number; notes: number; books: number; groups_open: number; photos: number; messages7: number }>(
        `SELECT (SELECT count(*) FROM posts WHERE university_id = $1 AND created_at > now() - interval '30 days')::int AS posts30,
                (SELECT count(*) FROM content_reports WHERE university_id = $1 AND status = 'open')::int AS reports_open,
                (SELECT count(*) FROM jobs WHERE university_id = $1 AND status = 'open')::int AS jobs_open,
                (SELECT count(*) FROM lost_items WHERE university_id = $1 AND status = 'open')::int AS lost_open,
                (SELECT count(*) FROM study_notes WHERE university_id = $1 AND status = 'visible')::int AS notes,
                (SELECT count(*) FROM books WHERE university_id = $1 AND status IN ('available', 'reserved'))::int AS books,
                (SELECT count(*) FROM study_groups WHERE university_id = $1 AND status = 'open')::int AS groups_open,
                (SELECT count(*) FROM photos WHERE university_id = $1)::int AS photos,
                (SELECT count(*) FROM messages WHERE university_id = $1 AND created_at > now() - interval '7 days')::int AS messages7`),
      one<{ upcoming: number; past30: number; going: number; checked_in: number }>(
        `SELECT count(*) FILTER (WHERE e.starts_at > now())::int AS upcoming,
                count(*) FILTER (WHERE e.starts_at <= now() AND e.starts_at > now() - interval '30 days')::int AS past30,
                COALESCE(sum((SELECT count(*) FROM rsvps r WHERE r.event_id = e.id AND r.status = 'going')) FILTER (WHERE e.starts_at <= now() AND e.starts_at > now() - interval '30 days'), 0)::int AS going,
                COALESCE(sum((SELECT count(*) FROM rsvps r WHERE r.event_id = e.id AND r.checked_in_at IS NOT NULL)) FILTER (WHERE e.starts_at <= now() AND e.starts_at > now() - interval '30 days'), 0)::int AS checked_in
           FROM events e WHERE e.university_id = $1`),
      pool.query<{ department: string; n: number }>("SELECT department, count(*)::int AS n FROM memberships WHERE university_id = $1 AND status = 'active' GROUP BY department ORDER BY n DESC LIMIT 12", [u]),
      pool.query<{ id: string; title: string; starts_at: Date; going: number; checked_in: number; capacity: number | null }>(
        `SELECT e.id, e.title, e.starts_at, e.capacity,
                (SELECT count(*)::int FROM rsvps r WHERE r.event_id = e.id AND r.status = 'going') AS going,
                (SELECT count(*)::int FROM rsvps r WHERE r.event_id = e.id AND r.checked_in_at IS NOT NULL) AS checked_in
           FROM events e WHERE e.university_id = $1 ORDER BY e.starts_at DESC LIMIT 8`, [u]),
      pool.query<{ name: string; members: number }>(
        'SELECT s.name, (SELECT count(*)::int FROM society_members x WHERE x.society_id = s.id) AS members FROM societies s WHERE s.university_id = $1 ORDER BY members DESC, s.name LIMIT 5', [u]),
    ]);
    return {
      members: { active: members.active, pending: members.pending, suspended: members.suspended, joinedLast30Days: members.new30 },
      events: { upcoming: events.upcoming, heldLast30Days: events.past30, ticketsLast30Days: events.going, checkedInLast30Days: events.checked_in },
      content: { postsLast30Days: content.posts30, openReports: content.reports_open, openJobs: content.jobs_open, openLostFound: content.lost_open, notes: content.notes, booksForSale: content.books, openStudyGroups: content.groups_open, photos: content.photos, messagesLast7Days: content.messages7 },
      membersByDepartment: byDept.rows.map(r => ({ department: r.department, count: r.n })),
      recentEvents: recent.rows.map(r => ({ id: r.id, title: r.title, startsAt: ms(r.starts_at), going: r.going, checkedIn: r.checked_in, capacity: r.capacity })),
      topSocieties: topSocieties.rows.map(r => ({ name: r.name, members: r.members })),
    };
  });
  // Approve, reject or suspend a member. Only a university admin can change roles.
  app.patch<{ Params: { userId: string } }>('/admin/members/:userId', admins, async req => {
    const admin = req.member!;
    const userId = uuid(req.params.userId);
    const body = parse(z.object({ status: z.enum(MEMBER_STATUSES).optional(), role: z.enum(ROLES).optional() }).refine(b => b.status || b.role, 'Nothing to change'), req.body);

    if (userId === admin.userId) {
      throw forbidden('You cannot change your own membership.');
    }
    // Same university only.
    const before = await pool.query<{ status: string }>('SELECT status FROM memberships WHERE user_id = $1 AND university_id = $2', [userId, admin.universityId]);
    if (!before.rows[0]) {
      throw notFound('Member not found.');
    }

    await pool.query(
      `UPDATE memberships SET status = COALESCE($3, status), role = COALESCE($4, role), updated_at = now()
        WHERE user_id = $1 AND university_id = $2`,
      [userId, admin.universityId, body.status ?? null, body.role ?? null],
    );

    if (before.rows[0].status !== 'active' && body.status === 'active') {
      await push.sendToUsers([userId], { title: "You're in!", body: 'Your university approved your request. Welcome to CampusHub.', data: { kind: 'official' } });
    }
    const { rows } = await pool.query<Row>(`${SELECT} WHERE m.user_id = $1`, [userId]);
    return dto(rows[0] as Row);
  });
};
