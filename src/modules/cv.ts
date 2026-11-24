import { z } from 'zod';

import { ms, parse } from '../lib/http.js';
import type { Routes } from './types.js';

/**
 * The CV builder. Only a short summary, skills and links are typed by the student. Everything else is
 * built from what the university's own records show: events attended, volunteering and societies.
 * That part cannot be edited, so it can be trusted.
 */
export const cvRoutes: Routes = async (app, { deps, guards }) => {
  const { pool } = deps;
  const member = { preHandler: guards.member };

  app.get('/cv', member, async req => {
    const m = req.member!;
    const [uni, profile, events, volunteering, societies] = await Promise.all([
      pool.query<{ full_name: string }>('SELECT full_name FROM universities WHERE id = $1', [m.universityId]),
      pool.query<{ summary: string; skills: string[]; links: string[]; updated_at: Date }>('SELECT summary, skills, links, updated_at FROM cv_profiles WHERE user_id = $1', [m.userId]),
      pool.query<{ title: string; at: Date }>(
        `SELECT e.title, e.starts_at AS at FROM rsvps r JOIN events e ON e.id = r.event_id
          WHERE r.user_id = $1 AND r.checked_in_at IS NOT NULL ORDER BY e.starts_at DESC LIMIT 15`,
        [m.userId],
      ),
      pool.query<{ title: string; at: Date }>(
        `SELECT e.title, e.starts_at AS at FROM rsvps r JOIN events e ON e.id = r.event_id
          WHERE r.user_id = $1 AND r.checked_in_at IS NOT NULL AND r.volunteer ORDER BY e.starts_at DESC LIMIT 15`,
        [m.userId],
      ),
      pool.query<{ name: string; role: string }>(
        'SELECT s.name, sm.role FROM society_members sm JOIN societies s ON s.id = sm.society_id WHERE sm.user_id = $1 ORDER BY (sm.role = \'head\') DESC, s.name',
        [m.userId],
      ),
    ]);
    const p = profile.rows[0];
    return {
      name: req.user!.name,
      email: req.user!.email,
      university: uni.rows[0]?.full_name ?? '',
      studentId: m.studentId,
      department: m.department,
      batch: m.batch,
      summary: p?.summary ?? '',
      skills: p?.skills ?? [],
      links: p?.links ?? [],
      // Verified by the university's records:
      eventsAttended: events.rows.map(e => ({ title: e.title, date: ms(e.at) })),
      volunteering: volunteering.rows.map(e => ({ title: e.title, date: ms(e.at) })),
      societies: societies.rows.map(s => ({ name: s.name, role: s.role })),
      generatedAt: Date.now(),
    };
  });

  app.put('/cv/profile', member, async req => {
    const m = req.member!;
    const b = parse(
      z.object({
        summary: z.string().trim().max(600).default(''),
        skills: z.array(z.string().trim().min(1).max(30)).max(15).default([]),
        links: z.array(z.string().trim().url().max(200).refine(u => u.startsWith('https://'), 'Links must start with https://')).max(3).default([]),
      }),
      req.body,
    );
    const skills = [...new Set(b.skills.map(s => s.replace(/\s+/g, ' ')))];
    await pool.query(
      `INSERT INTO cv_profiles (user_id, university_id, summary, skills, links) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET summary = EXCLUDED.summary, skills = EXCLUDED.skills, links = EXCLUDED.links, updated_at = now()`,
      [m.userId, m.universityId, b.summary, skills, b.links],
    );
    return { summary: b.summary, skills, links: b.links };
  });
};
