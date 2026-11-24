import { z } from 'zod';

import { ADMIN_ROLES } from '../domain.js';
import { notFound } from '../lib/errors.js';
import { ms, parse, uuid } from '../lib/http.js';
import type { Routes } from './types.js';

const KINDS = ['job', 'internship', 'part_time'] as const;

interface JobRow {
  id: string;
  company: string;
  title: string;
  kind: string;
  location: string;
  description: string;
  apply_url: string | null;
  apply_email: string | null;
  deadline: Date | null;
  status: string;
  created_at: Date;
  saved: boolean;
}

const SELECT = `
  SELECT j.id, j.company, j.title, j.kind, j.location, j.description, j.apply_url, j.apply_email, j.deadline, j.status, j.created_at,
    EXISTS (SELECT 1 FROM job_saves s WHERE s.job_id = j.id AND s.user_id = $2) AS saved
  FROM jobs j`;

const likeEscape = (s: string) => s.replace(/[\\%_]/g, c => `\\${c}`);

const fields = {
  company: z.string().trim().min(2).max(80),
  title: z.string().trim().min(3).max(100),
  kind: z.enum(KINDS),
  location: z.string().trim().max(80),
  description: z.string().trim().max(3000),
  applyUrl: z.string().trim().url().max(300).refine(u => u.startsWith('https://'), 'The apply link must start with https://').nullable(),
  applyEmail: z.string().trim().toLowerCase().email().max(200).nullable(),
  deadline: z.number().int().positive().nullable(),
};

/**
 * Jobs and internships are posted by the university's admins on behalf of companies,
 * so every opening is checked by someone at the university before students see it.
 */
export const jobsRoutes: Routes = async (app, { deps, guards }) => {
  const { pool } = deps;
  const member = { preHandler: guards.member };
  const admin = { preHandler: guards.roles(...ADMIN_ROLES) };

  const dto = (j: JobRow, isAdmin: boolean) => ({
    id: j.id,
    company: j.company,
    title: j.title,
    kind: j.kind,
    location: j.location,
    description: j.description,
    applyUrl: j.apply_url,
    applyEmail: j.apply_email,
    deadline: ms(j.deadline),
    expired: !!j.deadline && j.deadline.getTime() < Date.now(),
    status: j.status,
    saved: j.saved,
    canManage: isAdmin,
    createdAt: ms(j.created_at),
  });

  async function load(id: string, universityId: string, viewerId: string): Promise<JobRow> {
    const { rows } = await pool.query<JobRow>(`${SELECT} WHERE j.id = $1 AND j.university_id = $3`, [id, viewerId, universityId]);
    if (!rows[0]) {
      throw notFound('Job not found.');
    }
    return rows[0];
  }

  app.get<{ Querystring: { q?: string; kind?: string; scope?: string; include?: string } }>('/jobs', member, async req => {
    const m = req.member!;
    const isAdmin = ADMIN_ROLES.includes(m.role);
    const q = parse(z.object({ q: z.string().trim().max(60).optional(), kind: z.enum(KINDS).optional(), scope: z.enum(['open', 'saved']).default('open'), include: z.enum(['closed']).optional() }), req.query);
    const { rows } = await pool.query<JobRow>(
      `${SELECT}
        WHERE j.university_id = $1
          AND (($3 = 'saved' AND EXISTS (SELECT 1 FROM job_saves s WHERE s.job_id = j.id AND s.user_id = $2))
               OR ($3 = 'open' AND (($4::boolean AND $5::boolean) OR (j.status = 'open' AND (j.deadline IS NULL OR j.deadline > now())))))
          AND ($6::text IS NULL OR j.title ILIKE $6 OR j.company ILIKE $6 OR j.location ILIKE $6)
          AND ($7::text IS NULL OR j.kind = $7)
        ORDER BY j.created_at DESC LIMIT 100`,
      [m.universityId, m.userId, q.scope, isAdmin, q.include === 'closed', q.q ? `%${likeEscape(q.q)}%` : null, q.kind ?? null],
    );
    return { jobs: rows.map(j => dto(j, isAdmin)) };
  });

  app.get<{ Params: { id: string } }>('/jobs/:id', member, async req => {
    const m = req.member!;
    return dto(await load(uuid(req.params.id), m.universityId, m.userId), ADMIN_ROLES.includes(m.role));
  });

  const createSchema = z
    .object({ ...fields, location: fields.location.default(''), description: fields.description.default(''), applyUrl: fields.applyUrl.default(null), applyEmail: fields.applyEmail.default(null), deadline: fields.deadline.default(null) })
    .refine(j => !!j.applyUrl || !!j.applyEmail, { message: 'Give a link or an email where students can apply.', path: ['applyUrl'] });

  app.post('/jobs', admin, async (req, reply) => {
    const m = req.member!;
    const b = parse(createSchema, req.body);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO jobs (university_id, posted_by, company, title, kind, location, description, apply_url, apply_email, deadline)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $10::bigint IS NULL THEN NULL ELSE to_timestamp($10 / 1000.0) END) RETURNING id`,
      [m.universityId, m.userId, b.company, b.title, b.kind, b.location, b.description, b.applyUrl, b.applyEmail, b.deadline],
    );
    return reply.status(201).send(dto(await load((rows[0] as { id: string }).id, m.universityId, m.userId), true));
  });

  app.patch<{ Params: { id: string } }>('/jobs/:id', admin, async req => {
    const m = req.member!;
    const b = parse(
      z.object({ company: fields.company.optional(), title: fields.title.optional(), kind: fields.kind.optional(), location: fields.location.optional(), description: fields.description.optional(), status: z.enum(['open', 'closed']).optional() }),
      req.body,
    );
    const job = await load(uuid(req.params.id), m.universityId, m.userId);
    await pool.query(
      `UPDATE jobs SET company = COALESCE($2, company), title = COALESCE($3, title), kind = COALESCE($4, kind), location = COALESCE($5, location),
                       description = COALESCE($6, description), status = COALESCE($7, status) WHERE id = $1`,
      [job.id, b.company ?? null, b.title ?? null, b.kind ?? null, b.location ?? null, b.description ?? null, b.status ?? null],
    );
    return dto(await load(job.id, m.universityId, m.userId), true);
  });

  app.delete<{ Params: { id: string } }>('/jobs/:id', admin, async (req, reply) => {
    const m = req.member!;
    const job = await load(uuid(req.params.id), m.universityId, m.userId);
    await pool.query('DELETE FROM jobs WHERE id = $1', [job.id]);
    return reply.status(204).send();
  });

  app.put<{ Params: { id: string } }>('/jobs/:id/save', member, async req => {
    const m = req.member!;
    const job = await load(uuid(req.params.id), m.universityId, m.userId);
    await pool.query('INSERT INTO job_saves (job_id, university_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [job.id, m.universityId, m.userId]);
    return { saved: true };
  });

  app.delete<{ Params: { id: string } }>('/jobs/:id/save', member, async req => {
    const m = req.member!;
    const job = await load(uuid(req.params.id), m.universityId, m.userId);
    await pool.query('DELETE FROM job_saves WHERE job_id = $1 AND user_id = $2', [job.id, m.userId]);
    return { saved: false };
  });
};
