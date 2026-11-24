import { randomUUID } from 'node:crypto';

import multipart from '@fastify/multipart';
import { z } from 'zod';

import { ADMIN_ROLES } from '../domain.js';
import { withTx, type Db } from '../db/pool.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { ms, parse, uuid } from '../lib/http.js';
import { readMultipart } from '../lib/multipart.js';
import { processImage } from '../media/image.js';
import { signedPath, verifySignature } from '../media/signedUrl.js';
import type { Storage } from '../storage/index.js';
import type { Routes } from './types.js';

const MAX_FILES = 6;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const NOTE_KINDS = ['notes', 'past_paper', 'assignment', 'other'] as const;

interface NoteRow {
  id: string;
  title: string;
  course: string;
  department: string;
  kind: string;
  description: string;
  status: string;
  uploader_id: string;
  uploader_name: string;
  created_at: Date;
  helpful: number;
  voted: boolean;
  file_count: number;
}

const SELECT = `
  SELECT n.id, n.title, n.course, n.department, n.kind, n.description, n.status, n.uploader_id, u.name AS uploader_name, n.created_at,
    (SELECT count(*)::int FROM note_votes v WHERE v.note_id = n.id) AS helpful,
    EXISTS (SELECT 1 FROM note_votes v WHERE v.note_id = n.id AND v.user_id = $2) AS voted,
    (SELECT count(*)::int FROM note_files f WHERE f.note_id = n.id) AS file_count
  FROM study_notes n JOIN users u ON u.id = n.uploader_id`;

const likeEscape = (s: string) => s.replace(/[\\%_]/g, c => `\\${c}`);

/** Removes the files of everything a person shared (notes, book photos) before their rows disappear. */
export async function deleteUserStudyFiles(db: Db, storage: Storage, userId: string): Promise<void> {
  const notes = await db.query<{ storage_key: string }>('SELECT f.storage_key FROM note_files f JOIN study_notes n ON n.id = f.note_id WHERE n.uploader_id = $1', [userId]);
  const media = await db.query<{ storage_key: string; thumb_key: string }>('SELECT storage_key, thumb_key FROM media WHERE owner_id = $1', [userId]);
  await Promise.all([...notes.rows.map(r => r.storage_key), ...media.rows.flatMap(r => [r.storage_key, r.thumb_key])].map(k => storage.delete(k).catch(() => undefined)));
}

/** Removes a note's files from storage (after its rows are gone). */
export async function deleteNoteFiles(storage: Storage, keys: string[]) {
  await Promise.all(keys.map(k => storage.delete(k).catch(() => undefined)));
}

export const notesRoutes: Routes = async (app, { deps, guards }) => {
  const { config, pool, storage } = deps;
  const member = { preHandler: guards.member };

  await app.register(multipart, { limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES, fields: 8, parts: MAX_FILES + 8 } });

  const dto = (n: NoteRow, viewerId: string, isAdmin: boolean) => ({
    id: n.id,
    title: n.title,
    course: n.course,
    department: n.department,
    kind: n.kind,
    description: n.description,
    status: n.status,
    uploaderName: n.uploader_name,
    mine: n.uploader_id === viewerId,
    canManage: n.uploader_id === viewerId || isAdmin,
    helpfulCount: n.helpful,
    iFoundHelpful: n.voted,
    fileCount: n.file_count,
    createdAt: ms(n.created_at),
  });

  async function load(db: Db, id: string, universityId: string, viewerId: string, isAdmin: boolean): Promise<NoteRow> {
    const { rows } = await db.query<NoteRow>(`${SELECT} WHERE n.id = $1 AND n.university_id = $3`, [id, viewerId, universityId]);
    const n = rows[0];
    // A hidden note exists only for its uploader and the admins.
    if (!n || (n.status === 'hidden' && n.uploader_id !== viewerId && !isAdmin)) {
      throw notFound('Note not found.');
    }
    return n;
  }

  app.get<{ Querystring: { q?: string; course?: string; kind?: string; department?: string; include?: string } }>('/notes', member, async req => {
    const m = req.member!;
    const isAdmin = ADMIN_ROLES.includes(m.role);
    const q = parse(
      z.object({
        q: z.string().trim().max(60).optional(),
        course: z.string().trim().max(60).optional(),
        kind: z.enum(NOTE_KINDS).optional(),
        department: z.string().trim().max(80).optional(),
        include: z.enum(['hidden']).optional(),
      }),
      req.query,
    );
    const { rows } = await pool.query<NoteRow>(
      `${SELECT}
        WHERE n.university_id = $1 AND (n.status = 'visible' OR ($3::boolean AND $4::boolean))
          AND ($5::text IS NULL OR n.title ILIKE $5 OR n.course ILIKE $5 OR n.description ILIKE $5)
          AND ($6::text IS NULL OR lower(n.course) = lower($6))
          AND ($7::text IS NULL OR n.kind = $7)
          AND ($8::text IS NULL OR n.department = $8)
        ORDER BY n.created_at DESC LIMIT 100`,
      [m.universityId, m.userId, isAdmin, q.include === 'hidden', q.q ? `%${likeEscape(q.q)}%` : null, q.course ?? null, q.kind ?? null, q.department ?? null],
    );
    const courses = await pool.query<{ course: string }>(
      "SELECT DISTINCT course FROM study_notes WHERE university_id = $1 AND status = 'visible' ORDER BY course LIMIT 100",
      [m.universityId],
    );
    return { notes: rows.map(n => dto(n, m.userId, isAdmin)), courses: courses.rows.map(c => c.course) };
  });

  app.get<{ Params: { id: string } }>('/notes/:id', member, async req => {
    const m = req.member!;
    const isAdmin = ADMIN_ROLES.includes(m.role);
    const n = await load(pool, uuid(req.params.id), m.universityId, m.userId, isAdmin);
    const files = await pool.query<{ id: string; name: string; mime: string; bytes: number }>('SELECT id, name, mime, bytes FROM note_files WHERE note_id = $1 ORDER BY position', [n.id]);
    return { ...dto(n, m.userId, isAdmin), files: files.rows.map(f => ({ id: f.id, name: f.name, mime: f.mime, bytes: f.bytes, url: signedPath(config, 'doc', f.id, 'file') })) };
  });

  // Upload: a form with title, course, kind, description and 1-6 files (PDF or pictures).
  app.post('/notes', { preHandler: guards.member, config: { rateLimit: { max: config.nodeEnv === 'test' ? 100_000 : 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    const m = req.member!;
    const { fields, files } = await readMultipart(req, { maxFiles: MAX_FILES, maxBytes: MAX_FILE_BYTES });
    const body = parse(
      z.object({
        title: z.string().trim().min(3).max(100),
        course: z.string().trim().min(2).max(60),
        kind: z.enum(NOTE_KINDS).default('notes'),
        description: z.string().trim().max(500).default(''),
      }),
      fields,
    );
    if (files.length === 0) {
      throw badRequest('Attach at least one file (a PDF or a picture of your notes).');
    }

    const noteId = randomUUID();
    const stored: { id: string; key: string; name: string; mime: string; bytes: number }[] = [];
    try {
      for (const f of files) {
        const id = randomUUID();
        if (f.data.subarray(0, 5).toString('latin1') === '%PDF-') {
          const key = `${m.universityId}/notes/${noteId}/${id}.pdf`;
          await storage.put(key, f.data, 'application/pdf');
          stored.push({ id, key, name: f.name.replace(/\.[^.]*$/, '') + '.pdf', mime: 'application/pdf', bytes: f.data.length });
        } else {
          // Not a PDF: it must be a picture, and it is re-encoded (clean, resized, no hidden data).
          const image = await processImage(f.data);
          const key = `${m.universityId}/notes/${noteId}/${id}.jpg`;
          await storage.put(key, image.full, 'image/jpeg');
          stored.push({ id, key, name: f.name.replace(/\.[^.]*$/, '') + '.jpg', mime: 'image/jpeg', bytes: image.full.length });
        }
      }
      await withTx(pool, async c => {
        await c.query(
          'INSERT INTO study_notes (id, university_id, uploader_id, title, course, department, kind, description) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [noteId, m.universityId, m.userId, body.title, body.course, m.department, body.kind, body.description],
        );
        for (const [i, s] of stored.entries()) {
          await c.query('INSERT INTO note_files (id, note_id, university_id, storage_key, name, mime, bytes, position) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [s.id, noteId, m.universityId, s.key, s.name, s.mime, s.bytes, i]);
        }
      });
    } catch (err) {
      await deleteNoteFiles(storage, stored.map(s => s.key)); // nothing half-saved is left behind
      throw err;
    }
    return reply.status(201).send(dto(await load(pool, noteId, m.universityId, m.userId, false), m.userId, ADMIN_ROLES.includes(m.role)));
  });

  app.put<{ Params: { id: string } }>('/notes/:id/helpful', member, async req => {
    const m = req.member!;
    const n = await load(pool, uuid(req.params.id), m.universityId, m.userId, ADMIN_ROLES.includes(m.role));
    await pool.query('INSERT INTO note_votes (note_id, university_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [n.id, m.universityId, m.userId]);
    return { iFoundHelpful: true, helpfulCount: (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM note_votes WHERE note_id = $1', [n.id])).rows[0]?.n ?? 0 };
  });

  app.delete<{ Params: { id: string } }>('/notes/:id/helpful', member, async req => {
    const m = req.member!;
    const n = await load(pool, uuid(req.params.id), m.universityId, m.userId, ADMIN_ROLES.includes(m.role));
    await pool.query('DELETE FROM note_votes WHERE note_id = $1 AND user_id = $2', [n.id, m.userId]);
    return { iFoundHelpful: false, helpfulCount: (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM note_votes WHERE note_id = $1', [n.id])).rows[0]?.n ?? 0 };
  });

  app.delete<{ Params: { id: string } }>('/notes/:id', member, async (req, reply) => {
    const m = req.member!;
    const isAdmin = ADMIN_ROLES.includes(m.role);
    const n = await load(pool, uuid(req.params.id), m.universityId, m.userId, isAdmin);
    if (n.uploader_id !== m.userId && !isAdmin) {
      throw forbidden('Only the person who uploaded this note (or an admin) can delete it.');
    }
    const files = await pool.query<{ storage_key: string }>('SELECT storage_key FROM note_files WHERE note_id = $1', [n.id]);
    await pool.query('DELETE FROM study_notes WHERE id = $1', [n.id]);
    await deleteNoteFiles(storage, files.rows.map(f => f.storage_key));
    return reply.status(204).send();
  });

  // The document itself. The signed link is the proof; PDFs are always downloaded, never run in a page.
  app.get<{ Params: { id: string }; Querystring: { exp?: string; sig?: string } }>('/docs/:id/file', async (req, reply) => {
    const { id } = req.params;
    if (!verifySignature(config, 'doc', id, 'file', req.query.exp, req.query.sig)) {
      throw notFound();
    }
    const row = await pool.query<{ storage_key: string; name: string; mime: string; status: string }>(
      'SELECT f.storage_key, f.name, f.mime, n.status FROM note_files f JOIN study_notes n ON n.id = f.note_id WHERE f.id = $1',
      [uuid(id)],
    );
    const f = row.rows[0];
    const file = f && f.status === 'visible' ? await storage.open(f.storage_key) : null;
    if (!f || !file) {
      throw notFound();
    }
    return reply
      .header('Content-Type', f.mime)
      .header('Content-Length', file.size)
      .header('Content-Disposition', `${f.mime === 'application/pdf' ? 'attachment' : 'inline'}; filename="${f.name.replace(/[^\w.\- ]/g, '_')}"`)
      .header('Cache-Control', 'private, max-age=3600')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .send(file.stream);
  });
};
