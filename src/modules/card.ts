import { createHmac } from 'node:crypto';

import { z } from 'zod';

import type { Config } from '../config.js';
import { SCANNER_ROLES } from '../domain.js';
import { parse } from '../lib/http.js';
import { safeEqual } from '../lib/secrets.js';
import type { Routes } from './types.js';

/**
 * The digital student card. Its QR changes every 30 seconds and is signed by the server, so a
 * screenshot of someone's card stops working almost at once. Scanning it tells staff who the person
 * is and whether they are an approved member.
 *
 * Payload: CH1|C|university|userId|window|signature
 */

const WINDOW_MS = 30_000;
/** A scan up to two minutes old still counts (slow gates, phones with the wrong clock). */
const WINDOWS_ACCEPTED = 4;

const sign = (config: Config, universityId: string, userId: string, window: number) =>
  createHmac('sha256', config.jwtSecret).update(`card|${universityId}|${userId}|${window}`).digest('base64url').slice(0, 22);

export function cardPayload(config: Config, universityId: string, userId: string, now = Date.now()) {
  const window = Math.floor(now / WINDOW_MS);
  return { payload: `CH1|C|${universityId}|${userId}|${window}|${sign(config, universityId, userId, window)}`, refreshAt: (window + 1) * WINDOW_MS };
}

export function verifyCardPayload(config: Config, raw: string, now = Date.now()): { universityId: string; userId: string } | null {
  const parts = raw.trim().split('|');
  if (parts.length !== 6 || parts[0] !== 'CH1' || parts[1] !== 'C') {
    return null;
  }
  const [, , universityId, userId, windowText, sig] = parts as [string, string, string, string, string, string];
  const window = Number(windowText);
  const current = Math.floor(now / WINDOW_MS);
  if (!Number.isInteger(window) || window > current + 1 || window <= current - WINDOWS_ACCEPTED) {
    return null;
  }
  return safeEqual(sign(config, universityId, userId, window), sig) ? { universityId, userId } : null;
}

export const cardRoutes: Routes = async (app, { deps, guards }) => {
  const { config, pool } = deps;

  app.get('/card', { preHandler: guards.member }, async req => {
    const m = req.member!;
    const uni = await pool.query<{ name: string; full_name: string }>('SELECT name, full_name FROM universities WHERE id = $1', [m.universityId]);
    const { payload, refreshAt } = cardPayload(config, m.universityId, m.userId);
    return {
      payload,
      refreshAt,
      name: req.user!.name,
      photoUrl: req.user!.photoUrl,
      studentId: m.studentId,
      department: m.department,
      batch: m.batch,
      role: m.role,
      university: { id: m.universityId, name: uni.rows[0]?.name ?? '', fullName: uni.rows[0]?.full_name ?? '' },
    };
  });

  // Gate staff: who is this?
  app.post('/card/verify', { preHandler: guards.roles(...SCANNER_ROLES), config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async req => {
    const m = req.member!;
    const { payload } = parse(z.object({ payload: z.string().min(1).max(300) }), req.body);
    const who = verifyCardPayload(config, payload);
    if (!who) {
      return { ok: false, reason: 'invalid', detail: 'This card code is not valid or has expired. Ask the student to open their card again.' };
    }
    if (who.universityId !== m.universityId) {
      return { ok: false, reason: 'wrong_university', detail: 'This card belongs to another university.' };
    }
    const { rows } = await pool.query<{ name: string; photo_url: string | null; student_id: string; department: string; batch: string; role: string; status: string }>(
      `SELECT u.name, u.photo_url, mem.student_id, mem.department, mem.batch, mem.role, mem.status
         FROM memberships mem JOIN users u ON u.id = mem.user_id WHERE mem.user_id = $1 AND mem.university_id = $2`,
      [who.userId, m.universityId],
    );
    const r = rows[0];
    if (!r) {
      return { ok: false, reason: 'not_member', detail: 'This person is no longer a member.' };
    }
    if (r.status !== 'active') {
      return { ok: false, reason: 'not_active', name: r.name, detail: `Membership is ${r.status}.` };
    }
    return { ok: true, name: r.name, photoUrl: r.photo_url, studentId: r.student_id, department: r.department, batch: r.batch, role: r.role, detail: 'Verified student' };
  });
};
