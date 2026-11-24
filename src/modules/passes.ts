import { z } from 'zod';

import { MAX_GUESTS_PER_STUDENT, ORGANISER_ROLES, SCANNER_ROLES } from '../domain.js';
import { withTx } from '../db/pool.js';
import { conflict, notFound } from '../lib/errors.js';
import { ms, parse, uuid } from '../lib/http.js';
import { newTicketCode } from '../lib/secrets.js';
import type { Routes } from './types.js';

interface PassRow {
  id: string;
  event_id: string;
  event_title: string;
  host_id: string;
  host_name: string;
  guest_name: string;
  guest_phone: string;
  status: 'pending' | 'approved' | 'rejected';
  code: string;
  checked_in_at: Date | null;
  created_at: Date;
}

const SELECT = `SELECT g.*, e.title AS event_title FROM guest_passes g JOIN events e ON e.id = g.event_id`;

/** The secret code is only shown to the student who created the pass. */
const dto = (g: PassRow, includeCode: boolean) => ({
  id: g.id,
  eventId: g.event_id,
  eventTitle: g.event_title,
  hostUid: g.host_id,
  hostName: g.host_name,
  guestName: g.guest_name,
  guestPhone: g.guest_phone,
  status: g.status,
  code: includeCode ? g.code : '',
  checkedInAt: ms(g.checked_in_at),
  createdAt: ms(g.created_at),
});

export const passesRoutes: Routes = async (app, { deps, guards }) => {
  const { pool, push } = deps;
  const member = { preHandler: guards.member };

  // Bring a guest: only for an event the student holds a ticket for, up to two guests.
  app.post<{ Params: { id: string } }>('/events/:id/guest-passes', member, async (req, reply) => {
    const m = req.member!;
    const eventId = uuid(req.params.id);
    const body = parse(
      z.object({
        guestName: z.string().trim().min(2).max(80),
        guestPhone: z.string().trim().regex(/^[0-9+\-\s()]{7,20}$/, 'Enter a valid phone number'),
      }),
      req.body,
    );

    const id = await withTx(pool, async c => {
      const ev = await c.query<{ ends_at: Date }>('SELECT ends_at FROM events WHERE id = $1 AND university_id = $2', [eventId, m.universityId]);
      if (!ev.rows[0]) {
        throw notFound('Event not found.');
      }
      if (ev.rows[0].ends_at.getTime() < Date.now()) {
        throw conflict('This event has ended.', 'event_ended');
      }
      // Locking the host's ticket row serialises two quick taps from the same student.
      const ticket = await c.query<{ status: string }>('SELECT status FROM rsvps WHERE event_id = $1 AND user_id = $2 FOR UPDATE', [eventId, m.userId]);
      if (ticket.rows[0]?.status !== 'going') {
        throw conflict('You need a ticket for this event before you can bring a guest.', 'ticket_required');
      }
      const used = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM guest_passes WHERE event_id = $1 AND host_id = $2 AND status <> 'rejected'", [eventId, m.userId]);
      if ((used.rows[0]?.n ?? 0) >= MAX_GUESTS_PER_STUDENT) {
        throw conflict(`You can bring up to ${MAX_GUESTS_PER_STUDENT} guests to one event.`, 'guest_limit');
      }
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO guest_passes (university_id, event_id, host_id, host_name, guest_name, guest_phone, code)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [m.universityId, eventId, m.userId, req.user!.name, body.guestName, body.guestPhone, newTicketCode()],
      );
      return (rows[0] as { id: string }).id;
    });

    const { rows } = await pool.query<PassRow>(`${SELECT} WHERE g.id = $1`, [id]);
    return reply.status(201).send(dto(rows[0] as PassRow, true));
  });

  // My guests, for every event.
  app.get('/guest-passes', member, async req => {
    const { rows } = await pool.query<PassRow>(`${SELECT} WHERE g.host_id = $1 ORDER BY g.created_at DESC`, [req.member!.userId]);
    return { passes: rows.map(g => dto(g, true)) };
  });

  // Staff queue of passes waiting for a decision.
  app.get('/guest-passes/pending', { preHandler: guards.roles(...SCANNER_ROLES) }, async req => {
    const { rows } = await pool.query<PassRow>(`${SELECT} WHERE g.university_id = $1 AND g.status = 'pending' ORDER BY g.created_at`, [req.member!.universityId]);
    return { passes: rows.map(g => dto(g, false)) };
  });

  app.patch<{ Params: { id: string } }>('/guest-passes/:id', { preHandler: guards.roles(...ORGANISER_ROLES) }, async req => {
    const m = req.member!;
    const { approve } = parse(z.object({ approve: z.boolean() }), req.body);
    const id = uuid(req.params.id);
    const updated = await pool.query<{ id: string }>(
      "UPDATE guest_passes SET status = $3 WHERE id = $1 AND university_id = $2 AND status = 'pending' RETURNING id",
      [id, m.universityId, approve ? 'approved' : 'rejected'],
    );
    if (!updated.rows[0]) {
      const exists = await pool.query('SELECT 1 FROM guest_passes WHERE id = $1 AND university_id = $2', [id, m.universityId]);
      throw exists.rowCount === 0 ? notFound('Guest pass not found.') : conflict('This pass has already been decided.', 'already_decided');
    }
    const { rows } = await pool.query<PassRow>(`${SELECT} WHERE g.id = $1`, [id]);
    const g = rows[0] as PassRow;
    await push.sendToUsers([g.host_id], {
      title: approve ? 'Guest pass approved' : 'Guest pass not approved',
      body: approve ? `${g.guest_name} can now enter ${g.event_title}.` : `${g.guest_name} was not approved for ${g.event_title}.`,
      data: { kind: 'official', eventId: g.event_id },
    });
    return dto(g, false);
  });
};
