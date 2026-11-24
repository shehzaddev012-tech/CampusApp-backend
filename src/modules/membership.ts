import { z } from 'zod';

import { conflict, notFound } from '../lib/errors.js';
import { parse } from '../lib/http.js';
import { deleteUserPhotos } from './albums.js';
import { deleteUserStudyFiles } from './notes.js';
import { avatarKey } from './profile.js';
import type { Routes } from './types.js';

/** IAC-FA22-BCS-021: "IAC", the intake (two letters and the year), the programme, the roll number. */
export const STUDENT_ID_RE = /^IAC-[A-Z]{2}\d{2}-[A-Z]{2,6}-\d{2,4}$/;

const joinSchema = z.object({
  universityId: z.string().min(2).max(40),
  studentId: z
    .string()
    .trim()
    .toUpperCase()
    .regex(STUDENT_ID_RE, 'Your student ID looks like IAC-FA22-BCS-021 (IAC, then term and year, programme, roll number).'),
  department: z.string().trim().min(1).max(80),
  /** Optional and no longer asked for in the app. */
  batch: z.string().regex(/^\d{4}$/, 'Batch must be a 4-digit year').optional(),
});

export const membershipRoutes: Routes = async (app, { deps, guards }) => {
  const { pool } = deps;

  // A student asks to join a university. An admin there has to approve.
  app.post('/membership', { preHandler: guards.user }, async (req, reply) => {
    if (req.member) {
      throw conflict('You already belong to a university. Leave it first to join another.', 'already_member');
    }
    const body = parse(joinSchema, req.body);
    const dept = await pool.query('SELECT 1 FROM departments WHERE university_id = $1 AND name = $2', [body.universityId, body.department]);
    if (dept.rowCount === 0) {
      // Either the university or the department does not exist.
      const uni = await pool.query('SELECT 1 FROM universities WHERE id = $1', [body.universityId]);
      throw uni.rowCount === 0 ? notFound('University not found.') : conflict('That department does not exist at this university.', 'unknown_department');
    }
    try {
      await pool.query(
        `INSERT INTO memberships (user_id, university_id, student_id, department, batch, status)
         VALUES ($1, $2, $3, $4, $5, 'active')`,
        [req.user!.id, body.universityId, body.studentId, body.department, body.batch ?? ''],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw conflict('This student ID is already registered at this university.', 'student_id_taken');
      }
      throw err;
    }
    // No waiting for an admin: a correctly formatted ID that nobody else has taken is enough. An admin can still suspend someone.
    return reply.status(201).send({ status: 'active' });
  });

  // Leave the university (for example to switch). Your account stays.
  app.delete('/membership', { preHandler: guards.user }, async (req, reply) => {
    await deleteUserStudyFiles(pool, deps.storage, req.user!.id); // what they shared at this university goes with them
    await pool.query('DELETE FROM memberships WHERE user_id = $1', [req.user!.id]);
    return reply.status(204).send();
  });

  // Delete the account and everything tied to it.
  app.delete('/me', { preHandler: guards.user }, async (req, reply) => {
    await deleteUserPhotos(pool, deps.storage, req.user!.id); // their pictures go too, files included
    await deleteUserStudyFiles(pool, deps.storage, req.user!.id);
    await deps.storage.delete(avatarKey(req.user!.id)).catch(() => undefined);
    await pool.query('DELETE FROM users WHERE id = $1', [req.user!.id]);
    return reply.status(204).send();
  });
};
