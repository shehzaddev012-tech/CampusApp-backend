import { z } from 'zod';
import type pg from 'pg';

import { ADMIN_ROLES, EVENT_CATEGORIES, EVENT_LIST_WINDOW_DAYS, ORGANISER_ROLES, SCANNER_ROLES, type Role } from '../domain.js';
import { withTx, type Db } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { ms, parse, uuid } from '../lib/http.js';
import { newTicketCode, safeEqual } from '../lib/secrets.js';
import { canManageSociety } from './societies.js';
import type { PushProvider } from '../push/index.js';
import type { Routes } from './types.js';

// ── shapes ───────────────────────────────────────────────────────────────────

interface EventRow {
  id: string;
  university_id: string;
  title: string;
  organizer: string;
  category: string;
  blurb: string;
  venue: string;
  starts_at: Date;
  ends_at: Date;
  capacity: number | null;
  volunteers_needed: number;
  is_public: boolean;
  society_id: string | null;
  created_by: string | null;
  created_at: Date;
  going_count: number;
  interested_count: number;
  waitlist_count: number;
  checked_in_count: number;
  volunteer_count: number;
  schedule: { at: number; title: string; speaker: string | null }[];
}

/** An event with its live counters. Counted from the rows, never stored, so they cannot drift. */
export const EVENT_SELECT = `
  SELECT e.*,
    (SELECT count(*)::int FROM rsvps r WHERE r.event_id = e.id AND r.status = 'going')      AS going_count,
    (SELECT count(*)::int FROM rsvps r WHERE r.event_id = e.id AND r.status = 'interested') AS interested_count,
    (SELECT count(*)::int FROM rsvps r WHERE r.event_id = e.id AND r.status = 'waitlist')   AS waitlist_count,
    ((SELECT count(*) FROM rsvps r WHERE r.event_id = e.id AND r.checked_in_at IS NOT NULL)
     + (SELECT count(*) FROM guest_passes g WHERE g.event_id = e.id AND g.checked_in_at IS NOT NULL))::int AS checked_in_count,
    (SELECT count(*)::int FROM rsvps r WHERE r.event_id = e.id AND r.volunteer)             AS volunteer_count,
    COALESCE((SELECT json_agg(json_build_object('at', (extract(epoch FROM s.at) * 1000)::bigint, 'title', s.title, 'speaker', s.speaker) ORDER BY s.at)
                FROM event_schedule s WHERE s.event_id = e.id), '[]'::json) AS schedule
  FROM events e`;

export const eventDto = (e: EventRow) => ({
  id: e.id,
  universityId: e.university_id,
  title: e.title,
  organizer: e.organizer,
  category: e.category,
  blurb: e.blurb,
  venue: e.venue,
  startsAt: ms(e.starts_at),
  endsAt: ms(e.ends_at),
  capacity: e.capacity,
  goingCount: e.going_count,
  interestedCount: e.interested_count,
  waitlistCount: e.waitlist_count,
  checkedInCount: e.checked_in_count,
  volunteersNeeded: e.volunteers_needed,
  volunteerCount: e.volunteer_count,
  schedule: e.schedule.map(s => ({ at: Number(s.at), title: s.title, speaker: s.speaker ?? undefined })),
  isPublic: e.is_public,
  societyId: e.society_id,
  createdBy: e.created_by ?? '',
  createdAt: ms(e.created_at),
});

interface RsvpRow {
  event_id: string;
  user_id: string;
  student_name: string;
  status: 'going' | 'interested' | 'waitlist';
  code: string | null;
  checked_in_at: Date | null;
  volunteer: boolean;
  rating: number | null;
  feedback: string | null;
  created_at: Date;
}

/** Only ever returned to the student who owns it: `code` is the secret behind the QR ticket. */
export const rsvpDto = (r: RsvpRow) => ({
  eventId: r.event_id,
  uid: r.user_id,
  studentName: r.student_name,
  status: r.status,
  code: r.code,
  checkedInAt: ms(r.checked_in_at),
  volunteer: r.volunteer,
  rating: r.rating,
  feedback: r.feedback,
  createdAt: ms(r.created_at),
});

/** An event of MY university, or 404. */
async function loadEvent(db: Db, id: string, universityId: string): Promise<EventRow> {
  const { rows } = await db.query<EventRow>(`${EVENT_SELECT} WHERE e.id = $1 AND e.university_id = $2`, [id, universityId]);
  if (!rows[0]) {
    throw notFound('Event not found.');
  }
  return rows[0];
}

// ── QR payloads: CH1|T|uni|event|uid|code (student) and CH1|G|uni|event|passId|code (guest) ──

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parsePayload(raw: string) {
  const parts = raw.trim().split('|');
  if (parts.length !== 6 || parts[0] !== 'CH1' || (parts[1] !== 'T' && parts[1] !== 'G')) {
    return null;
  }
  const [, type, universityId, eventId, ownerId, code] = parts as [string, string, string, string, string, string];
  if (!universityId || !UUID.test(eventId) || !UUID.test(ownerId) || code.length < 12 || code.length > 64) {
    return null;
  }
  return { kind: type === 'T' ? ('ticket' as const) : ('guest' as const), universityId, eventId, ownerId, code };
}

const SHORT_CODE = /^[a-z0-9]{4}-?[a-z0-9]{4}$/i;

/** Turns the short code on a ticket / guest pass into the full QR payload, or null if nothing (or more than one thing) matches. */
export async function expandShortCode(pool: pg.Pool, universityId: string, eventId: string, short: string): Promise<string | null> {
  const key = short.replace('-', '').toLowerCase();
  const t = await pool.query<{ user_id: string; code: string }>(
    "SELECT user_id, code FROM rsvps WHERE event_id = $1 AND status = 'going' AND code IS NOT NULL AND left(lower(code), 8) = $2",
    [eventId, key],
  );
  const g = await pool.query<{ id: string; code: string }>(
    'SELECT id, code FROM guest_passes WHERE event_id = $1 AND university_id = $2 AND left(lower(code), 8) = $3',
    [eventId, universityId, key],
  );
  if (t.rows.length + g.rows.length !== 1) {
    return null;
  }
  const ticket = t.rows[0];
  if (ticket) {
    return `CH1|T|${universityId}|${eventId}|${ticket.user_id}|${ticket.code}`;
  }
  const pass = g.rows[0] as { id: string; code: string };
  return `CH1|G|${universityId}|${eventId}|${pass.id}|${pass.code}`;
}

export type CheckInResult =
  | { ok: true; kind: 'ticket' | 'guest'; name: string; detail: string }
  | { ok: false; reason: 'invalid' | 'wrong_event' | 'not_valid' | 'already_used' | 'pending' | 'closed'; name?: string; detail: string };

const HOUR = 3_600_000;
/** Gates open three hours before the start and stay open two hours after the end. */
const CHECKIN_OPENS_BEFORE_MS = 3 * HOUR;
const CHECKIN_CLOSES_AFTER_MS = 2 * HOUR;

const timeOfDay = (d: Date) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

/** Validates a scanned QR and marks it used. At most one scan of the same code can ever succeed. */
export async function checkIn(pool: pg.Pool, universityId: string, raw: string, eventId: string | undefined, now = new Date()): Promise<CheckInResult> {
  const p = parsePayload(raw);
  if (!p) {
    return { ok: false, reason: 'invalid', detail: 'This is not a CampusHub QR code.' };
  }
  if (p.universityId !== universityId) {
    return { ok: false, reason: 'wrong_event', detail: 'This ticket belongs to another university.' };
  }
  if (eventId && p.eventId !== eventId) {
    return { ok: false, reason: 'wrong_event', detail: 'This ticket is for a different event.' };
  }
  const ev = await pool.query<{ starts_at: Date; ends_at: Date }>('SELECT starts_at, ends_at FROM events WHERE id = $1 AND university_id = $2', [p.eventId, universityId]);
  const event = ev.rows[0];
  if (!event) {
    return { ok: false, reason: 'invalid', detail: 'The event for this ticket was not found.' };
  }
  if (now.getTime() < event.starts_at.getTime() - CHECKIN_OPENS_BEFORE_MS) {
    return { ok: false, reason: 'closed', detail: 'Check-in has not opened yet. It opens 3 hours before the event.' };
  }
  if (now.getTime() > event.ends_at.getTime() + CHECKIN_CLOSES_AFTER_MS) {
    return { ok: false, reason: 'closed', detail: 'This event has finished. Check-in is closed.' };
  }

  if (p.kind === 'ticket') {
    const { rows } = await pool.query<RsvpRow>('SELECT * FROM rsvps WHERE event_id = $1 AND user_id = $2', [p.eventId, p.ownerId]);
    const r = rows[0];
    if (!r || r.status !== 'going' || !r.code || !safeEqual(r.code, p.code)) {
      return { ok: false, reason: 'not_valid', name: r?.student_name, detail: 'No valid ticket matches this code.' };
    }
    // The WHERE clause makes this atomic: two scanners racing, exactly one gets a row back.
    const won = await pool.query<{ checked_in_at: Date }>(
      'UPDATE rsvps SET checked_in_at = $3 WHERE event_id = $1 AND user_id = $2 AND checked_in_at IS NULL RETURNING checked_in_at',
      [p.eventId, p.ownerId, now],
    );
    if (!won.rows[0]) {
      const again = await pool.query<{ checked_in_at: Date }>('SELECT checked_in_at FROM rsvps WHERE event_id = $1 AND user_id = $2', [p.eventId, p.ownerId]);
      const at = again.rows[0]?.checked_in_at;
      return { ok: false, reason: 'already_used', name: r.student_name, detail: at ? `Already checked in at ${timeOfDay(at)}.` : 'Already checked in.' };
    }
    return { ok: true, kind: 'ticket', name: r.student_name, detail: 'Student ticket' };
  }

  const { rows } = await pool.query<{ id: string; guest_name: string; host_name: string; status: string; code: string }>(
    'SELECT id, guest_name, host_name, status, code FROM guest_passes WHERE id = $1 AND event_id = $2 AND university_id = $3',
    [p.ownerId, p.eventId, universityId],
  );
  const g = rows[0];
  if (!g || !safeEqual(g.code, p.code) || g.status === 'rejected') {
    return { ok: false, reason: 'not_valid', name: g?.guest_name, detail: 'No valid guest pass matches this code.' };
  }
  if (g.status === 'pending') {
    return { ok: false, reason: 'pending', name: g.guest_name, detail: 'This pass is still waiting for approval.' };
  }
  const won = await pool.query<{ checked_in_at: Date }>(
    "UPDATE guest_passes SET checked_in_at = $2 WHERE id = $1 AND status = 'approved' AND checked_in_at IS NULL RETURNING checked_in_at",
    [g.id, now],
  );
  if (!won.rows[0]) {
    const again = await pool.query<{ checked_in_at: Date }>('SELECT checked_in_at FROM guest_passes WHERE id = $1', [g.id]);
    const at = again.rows[0]?.checked_in_at;
    return { ok: false, reason: 'already_used', name: g.guest_name, detail: at ? `Already checked in at ${timeOfDay(at)}.` : 'Already checked in.' };
  }
  return { ok: true, kind: 'guest', name: g.guest_name, detail: `Guest of ${g.host_name}` };
}

// ── seats ────────────────────────────────────────────────────────────────────

/**
 * Takes a seat if one is free, otherwise joins the waiting list. The event row is locked
 * (SELECT ... FOR UPDATE) for the duration, so a hundred students tapping at once can never
 * be given more seats than the event has.
 */
export async function takeSeat(pool: pg.Pool, universityId: string, eventId: string, userId: string, studentName: string, want: 'going' | 'interested', now = new Date()): Promise<RsvpRow> {
  return withTx(pool, async c => {
    const ev = await c.query<{ capacity: number | null; ends_at: Date }>('SELECT capacity, ends_at FROM events WHERE id = $1 AND university_id = $2 FOR UPDATE', [eventId, universityId]);
    const event = ev.rows[0];
    if (!event) {
      throw notFound('Event not found.');
    }
    if (now.getTime() > event.ends_at.getTime()) {
      throw conflict('This event has ended.', 'event_ended');
    }

    const existing = (await c.query<RsvpRow>('SELECT * FROM rsvps WHERE event_id = $1 AND user_id = $2', [eventId, userId])).rows[0];
    if (existing && (existing.status === 'going' || existing.status === 'waitlist')) {
      return existing;
    }
    if (existing && want === 'interested') {
      return existing;
    }

    if (want === 'interested') {
      const { rows } = await c.query<RsvpRow>(
        "INSERT INTO rsvps (event_id, user_id, student_name, status) VALUES ($1, $2, $3, 'interested') RETURNING *",
        [eventId, userId, studentName],
      );
      return rows[0] as RsvpRow;
    }

    const taken = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM rsvps WHERE event_id = $1 AND status = 'going'", [eventId])).rows[0]?.n ?? 0;
    const hasSeat = event.capacity === null || taken < event.capacity;
    const status = hasSeat ? 'going' : 'waitlist';
    const code = hasSeat ? newTicketCode() : null;

    if (existing) {
      // Was only "interested": the place in the queue starts now.
      const { rows } = await c.query<RsvpRow>(
        'UPDATE rsvps SET status = $3, code = $4, created_at = now() WHERE event_id = $1 AND user_id = $2 RETURNING *',
        [eventId, userId, status, code],
      );
      return rows[0] as RsvpRow;
    }
    const { rows } = await c.query<RsvpRow>(
      'INSERT INTO rsvps (event_id, user_id, student_name, status, code) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [eventId, userId, studentName, status, code],
    );
    return rows[0] as RsvpRow;
  });
}

/** Gives up a seat or an interest. A freed seat goes to the first student on the waiting list. */
export async function cancelRsvp(pool: pg.Pool, universityId: string, eventId: string, userId: string): Promise<{ promotedUserId: string | null; eventTitle: string }> {
  return withTx(pool, async c => {
    const ev = await c.query<{ title: string }>('SELECT title FROM events WHERE id = $1 AND university_id = $2 FOR UPDATE', [eventId, universityId]);
    if (!ev.rows[0]) {
      throw notFound('Event not found.');
    }
    const gone = await c.query<{ status: string }>('DELETE FROM rsvps WHERE event_id = $1 AND user_id = $2 RETURNING status', [eventId, userId]);
    let promotedUserId: string | null = null;
    if (gone.rows[0]?.status === 'going') {
      const next = await c.query<{ user_id: string }>(
        "SELECT user_id FROM rsvps WHERE event_id = $1 AND status = 'waitlist' ORDER BY created_at, user_id LIMIT 1",
        [eventId],
      );
      const winner = next.rows[0]?.user_id;
      if (winner) {
        await c.query("UPDATE rsvps SET status = 'going', code = $3 WHERE event_id = $1 AND user_id = $2", [eventId, winner, newTicketCode()]);
        promotedUserId = winner;
      }
    }
    return { promotedUserId, eventTitle: ev.rows[0].title };
  });
}

// ── routes ───────────────────────────────────────────────────────────────────

const createSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    /** Who organises it. When a society is chosen, the society's own name is used. */
    organizer: z.string().trim().min(2).max(100).optional(),
    societyId: z.string().uuid().nullable().default(null),
    category: z.enum(EVENT_CATEGORIES),
    blurb: z.string().trim().min(10).max(1500),
    venue: z.string().trim().min(2).max(100),
    startsAt: z.number().int().positive(),
    endsAt: z.number().int().positive(),
    capacity: z.number().int().min(1).max(100_000).nullable().default(null),
    volunteersNeeded: z.number().int().min(0).max(1000).default(0),
    isPublic: z.boolean().default(false),
    schedule: z.array(z.object({ at: z.number().int().positive(), title: z.string().trim().min(2).max(120), speaker: z.string().trim().max(80).optional() })).max(40).default([]),
  })
  .refine(e => e.endsAt > e.startsAt, { message: 'The event must end after it starts.', path: ['endsAt'] })
  .refine(e => e.endsAt - e.startsAt <= 7 * 24 * HOUR, { message: 'An event cannot last longer than 7 days.', path: ['endsAt'] });

export const eventsRoutes: Routes = async (app, { deps, guards }) => {
  const { pool, push } = deps;
  const member = { preHandler: guards.member };

  // Events (recent and upcoming) plus MY ticket for each. Tickets of other students are never returned.
  app.get('/events', member, async req => {
    const m = req.member!;
    const { rows } = await pool.query<EventRow>(
      `${EVENT_SELECT} WHERE e.university_id = $1 AND e.ends_at >= now() - make_interval(days => $2) ORDER BY e.starts_at`,
      [m.universityId, EVENT_LIST_WINDOW_DAYS],
    );
    const mine = await pool.query<RsvpRow>('SELECT * FROM rsvps WHERE user_id = $1 AND event_id = ANY($2::uuid[])', [m.userId, rows.map(r => r.id)]);
    return {
      events: rows.map(eventDto),
      myRsvps: Object.fromEntries(mine.rows.map(r => [r.event_id, rsvpDto(r)])),
    };
  });

  app.get<{ Params: { id: string } }>('/events/:id', member, async req => eventDto(await loadEvent(pool, uuid(req.params.id), req.member!.universityId)));

  app.post('/events', { preHandler: guards.roles(...ORGANISER_ROLES) }, async (req, reply) => {
    const m = req.member!;
    const body = parse(createSchema, req.body);
    let organizer = body.organizer ?? '';
    if (body.societyId) {
      if (!(await canManageSociety(pool, body.societyId, m.universityId, m.userId, m.role))) {
        throw forbidden('Only the head of this society (or an admin) can create events for it.');
      }
      organizer = (await pool.query<{ name: string }>('SELECT name FROM societies WHERE id = $1', [body.societyId])).rows[0]?.name ?? organizer;
    } else if (m.role === 'society_head') {
      throw forbidden('Choose the society this event is for.');
    }
    if (!organizer) {
      throw badRequest('Say who is organising this event.');
    }
    const id = await withTx(pool, async c => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO events (university_id, title, organizer, category, blurb, venue, starts_at, ends_at, capacity, volunteers_needed, is_public, created_by, society_id)
         VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0), to_timestamp($8 / 1000.0), $9, $10, $11, $12, $13) RETURNING id`,
        [m.universityId, body.title, organizer, body.category, body.blurb, body.venue, body.startsAt, body.endsAt, body.capacity, body.volunteersNeeded, body.isPublic, m.userId, body.societyId],
      );
      const eventId = (rows[0] as { id: string }).id;
      for (const s of body.schedule) {
        await c.query('INSERT INTO event_schedule (event_id, at, title, speaker) VALUES ($1, to_timestamp($2 / 1000.0), $3, $4)', [eventId, s.at, s.title, s.speaker ?? null]);
      }
      return eventId;
    });
    return reply.status(201).send(eventDto(await loadEvent(pool, id, m.universityId)));
  });

  /** The people who run this event: an admin of this university, or the head of its society. */
  const mustManage = async (m: { role: Role; universityId: string; userId: string }, event: EventRow) => {
    const ok = ADMIN_ROLES.includes(m.role) || (event.society_id !== null && (await canManageSociety(pool, event.society_id, m.universityId, m.userId, m.role)));
    if (!ok) {
      throw forbidden('Only an admin or the head of the organising society can manage this event.');
    }
  };

  // Edit the basics of an event. The schedule is not changed here.
  app.patch<{ Params: { id: string } }>('/events/:id', { preHandler: guards.roles(...ORGANISER_ROLES) }, async req => {
    const m = req.member!;
    const body = parse(
      z.object({
        title: z.string().trim().min(3).max(120).optional(),
        blurb: z.string().trim().min(10).max(1500).optional(),
        venue: z.string().trim().min(2).max(100).optional(),
        category: z.enum(EVENT_CATEGORIES).optional(),
        startsAt: z.number().int().positive().optional(),
        endsAt: z.number().int().positive().optional(),
        capacity: z.number().int().min(1).max(100_000).nullable().optional(),
        isPublic: z.boolean().optional(),
      }),
      req.body,
    );
    const event = await loadEvent(pool, uuid(req.params.id), m.universityId);
    await mustManage(m, event);
    const start = body.startsAt ?? event.starts_at.getTime();
    const end = body.endsAt ?? event.ends_at.getTime();
    if (end <= start || end - start > 7 * 24 * HOUR) {
      throw badRequest('The event must end after it starts, and last at most 7 days.');
    }
    if (body.capacity !== undefined && body.capacity !== null && body.capacity < event.going_count) {
      throw conflict(`${event.going_count} students already have a ticket, so the capacity cannot be lower than that.`, 'capacity_too_low');
    }
    await pool.query(
      `UPDATE events SET title = COALESCE($3, title), blurb = COALESCE($4, blurb), venue = COALESCE($5, venue), category = COALESCE($6, category),
              starts_at = to_timestamp($7 / 1000.0), ends_at = to_timestamp($8 / 1000.0),
              capacity = CASE WHEN $9::boolean THEN $10 ELSE capacity END, is_public = COALESCE($11, is_public)
        WHERE id = $1 AND university_id = $2`,
      [event.id, m.universityId, body.title ?? null, body.blurb ?? null, body.venue ?? null, body.category ?? null, start, end, body.capacity !== undefined, body.capacity ?? null, body.isPublic ?? null],
    );
    return eventDto(await loadEvent(pool, event.id, m.universityId));
  });

  // Cancel (delete) an event. Everyone with a ticket is told.
  app.delete<{ Params: { id: string } }>('/events/:id', { preHandler: guards.roles(...ORGANISER_ROLES) }, async (req, reply) => {
    const m = req.member!;
    const event = await loadEvent(pool, uuid(req.params.id), m.universityId);
    await mustManage(m, event);
    const going = await pool.query<{ user_id: string }>("SELECT user_id FROM rsvps WHERE event_id = $1 AND status IN ('going', 'waitlist')", [event.id]);
    await pool.query('DELETE FROM events WHERE id = $1 AND university_id = $2', [event.id, m.universityId]);
    if (going.rows.length > 0 && event.ends_at.getTime() > Date.now()) {
      await push.sendToUsers(going.rows.map(r => r.user_id), { title: 'Event cancelled', body: `${event.title} has been cancelled.`, data: { kind: 'official' } });
    }
    return reply.status(204).send();
  });

  // Who is coming, and who has already come in (names only; ticket codes are never shown).
  app.get<{ Params: { id: string } }>('/events/:id/attendees', { preHandler: guards.roles(...ORGANISER_ROLES) }, async req => {
    const m = req.member!;
    const event = await loadEvent(pool, uuid(req.params.id), m.universityId);
    await mustManage(m, event);
    const { rows } = await pool.query<{ student_name: string; status: string; checked_in_at: Date | null; volunteer: boolean; rating: number | null }>(
      `SELECT student_name, status, checked_in_at, volunteer, rating FROM rsvps
        WHERE event_id = $1 AND status IN ('going', 'waitlist') ORDER BY (checked_in_at IS NULL), student_name LIMIT 1000`,
      [event.id],
    );
    return { attendees: rows.map(r => ({ name: r.student_name, status: r.status, checkedInAt: ms(r.checked_in_at), volunteer: r.volunteer, rating: r.rating })) };
  });

  app.put<{ Params: { id: string } }>('/events/:id/rsvp', member, async req => {
    const m = req.member!;
    const { status } = parse(z.object({ status: z.enum(['going', 'interested']) }), req.body);
    const rsvp = await takeSeat(pool, m.universityId, uuid(req.params.id), m.userId, req.user!.name, status);
    return rsvpDto(rsvp);
  });

  app.delete<{ Params: { id: string } }>('/events/:id/rsvp', member, async (req, reply) => {
    const m = req.member!;
    const { promotedUserId, eventTitle } = await cancelRsvp(pool, m.universityId, uuid(req.params.id), m.userId);
    if (promotedUserId) {
      await notifyPromoted(push, promotedUserId, eventTitle, req.params.id);
    }
    return reply.status(204).send();
  });

  app.put<{ Params: { id: string } }>('/events/:id/volunteer', member, async req => {
    const m = req.member!;
    const { volunteer } = parse(z.object({ volunteer: z.boolean() }), req.body);
    const event = await loadEvent(pool, uuid(req.params.id), m.universityId);
    if (event.ends_at.getTime() < Date.now()) {
      throw conflict('This event has ended.', 'event_ended');
    }
    const { rows } = await pool.query<RsvpRow>(
      `INSERT INTO rsvps (event_id, user_id, student_name, status, volunteer) VALUES ($1, $2, $3, 'interested', $4)
       ON CONFLICT (event_id, user_id) DO UPDATE SET volunteer = EXCLUDED.volunteer
       RETURNING *`,
      [event.id, m.userId, req.user!.name, volunteer],
    );
    return rsvpDto(rows[0] as RsvpRow);
  });

  // Only students who joined and whose event is over can rate it.
  app.put<{ Params: { id: string } }>('/events/:id/feedback', member, async req => {
    const m = req.member!;
    const body = parse(z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(300).default('') }), req.body);
    const event = await loadEvent(pool, uuid(req.params.id), m.universityId);
    if (event.ends_at.getTime() > Date.now()) {
      throw conflict('You can rate an event after it has finished.', 'event_not_over');
    }
    const { rows } = await pool.query<RsvpRow>(
      "UPDATE rsvps SET rating = $3, feedback = $4 WHERE event_id = $1 AND user_id = $2 AND status = 'going' RETURNING *",
      [event.id, m.userId, body.rating, body.comment || null],
    );
    if (!rows[0]) {
      throw conflict('Only students who had a ticket can leave feedback.', 'no_ticket');
    }
    return rsvpDto(rows[0]);
  });

  // The gate scanner.
  app.post('/checkin', { preHandler: guards.roles(...SCANNER_ROLES), config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async req => {
    const body = parse(z.object({ payload: z.string().min(1).max(500), eventId: z.string().optional() }), req.body);
    if (body.eventId !== undefined && !UUID.test(body.eventId)) {
      throw badRequest('Invalid event.');
    }
    // The short code printed under a QR (ES52-VPIN) works too, for an event the scanner has picked.
    let payload = body.payload;
    if (SHORT_CODE.test(payload.trim())) {
      if (!body.eventId) {
        return { ok: false, reason: 'invalid', detail: 'Pick the event above first, then type the code.' } satisfies CheckInResult;
      }
      const full = await expandShortCode(pool, req.member!.universityId, body.eventId, payload.trim());
      if (!full) {
        return { ok: false, reason: 'not_valid', detail: 'No ticket or guest pass for this event has that code.' } satisfies CheckInResult;
      }
      payload = full;
    }
    return checkIn(pool, req.member!.universityId, payload, body.eventId);
  });
};

export async function notifyPromoted(push: PushProvider, userId: string, eventTitle: string, eventId: string) {
  await push.sendToUsers([userId], {
    title: 'A seat opened up',
    body: `You now have a ticket for ${eventTitle}.`,
    data: { kind: 'official', eventId },
  });
}
