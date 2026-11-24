import { z } from 'zod';

import { ADMIN_ROLES } from '../domain.js';
import { withTx, type Db } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { ms, parse, uuid } from '../lib/http.js';
import { emptyTrash } from '../media/trash.js';
import { removeStory } from './stories.js';
import type { Routes } from './types.js';

export const REPORT_TARGETS = ['note', 'book', 'study_group', 'job', 'lost_item', 'photo', 'message', 'user', 'story'] as const;
export type ReportTarget = (typeof REPORT_TARGETS)[number];
export const REPORT_REASONS = ['spam', 'inappropriate', 'copyright', 'scam', 'harassment', 'other'] as const;

interface TargetInfo {
  /** The text an admin sees ("what was reported"). */
  title: string;
  /** Who posted it (cannot report your own). */
  owner: string | null;
}

/** Looks the reported thing up INSIDE this university, or null when it does not exist here. */
async function describe(db: Db, type: ReportTarget, id: string, universityId: string): Promise<TargetInfo | null> {
  const q = async (sql: string) => (await db.query<{ title: string; owner: string | null }>(sql, [id, universityId])).rows[0] ?? null;
  switch (type) {
    case 'note':
      return q('SELECT title, uploader_id::text AS owner FROM study_notes WHERE id = $1 AND university_id = $2');
    case 'book':
      return q('SELECT title, seller_id::text AS owner FROM books WHERE id = $1 AND university_id = $2');
    case 'study_group':
      return q('SELECT title, created_by::text AS owner FROM study_groups WHERE id = $1 AND university_id = $2');
    case 'job':
      return q("SELECT company || ': ' || title AS title, posted_by::text AS owner FROM jobs WHERE id = $1 AND university_id = $2");
    case 'lost_item':
      return q('SELECT title, created_by::text AS owner FROM lost_items WHERE id = $1 AND university_id = $2');
    case 'photo':
      return q("SELECT 'A photo in an album' AS title, uploader_id::text AS owner FROM photos WHERE id = $1 AND university_id = $2");
    case 'message':
      return q("SELECT COALESCE(NULLIF(left(body, 80), ''), 'A picture or document') AS title, sender_id::text AS owner FROM messages WHERE id = $1 AND university_id = $2");
    case 'story':
      return q("SELECT 'A story: ' || COALESCE(NULLIF(caption, ''), '(no text)') AS title, user_id::text AS owner FROM stories WHERE id = $1 AND university_id = $2 AND expires_at > now()");
    case 'user':
      return q('SELECT u.name AS title, u.id::text AS owner FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.user_id = $1 AND m.university_id = $2');
  }
}

export const reportsRoutes: Routes = async (app, { deps, guards }) => {
  const { config, pool, storage } = deps;
  const admin = { preHandler: guards.roles(...ADMIN_ROLES) };

  // Anyone can report something in their own university. One report per person per item.
  app.post('/reports', { preHandler: guards.member, config: { rateLimit: { max: config.nodeEnv === 'test' ? 100_000 : 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    const m = req.member!;
    const b = parse(z.object({ targetType: z.enum(REPORT_TARGETS), targetId: z.string().uuid(), reason: z.enum(REPORT_REASONS), details: z.string().trim().max(500).default('') }), req.body);
    const target = await describe(pool, b.targetType, b.targetId, m.universityId);
    if (!target) {
      throw notFound('That item does not exist.');
    }
    if (b.targetType === 'message') {
      // You can only report a message you are allowed to read.
      const ok = await pool.query(`SELECT 1 FROM messages x JOIN conversations c ON c.id = x.conversation_id WHERE x.id = $1 AND ((c.kind = 'dm' AND $2 IN (c.user_a, c.user_b)) OR (c.kind = 'custom' AND EXISTS (SELECT 1 FROM conversation_members cmm WHERE cmm.conversation_id = c.id AND cmm.user_id = $2)) OR (c.kind = 'society' AND EXISTS (SELECT 1 FROM society_members s WHERE s.society_id = c.society_id AND s.user_id = $2)) OR (c.kind = 'group' AND EXISTS (SELECT 1 FROM study_group_members g WHERE g.group_id = c.group_id AND g.user_id = $2)))`, [b.targetId, m.userId]);
      if (!ok.rowCount) {
        throw notFound('That item does not exist.');
      }
    }
    if (target.owner === m.userId) {
      throw badRequest('You cannot report your own post.');
    }
    await pool.query(
      `INSERT INTO content_reports (university_id, reporter_id, target_type, target_id, reason, details) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (reporter_id, target_type, target_id) DO NOTHING`,
      [m.universityId, m.userId, b.targetType, b.targetId, b.reason, b.details],
    );
    return reply.status(201).send({ ok: true });
  });

  // ── admins ────────────────────────────────────────────────────────────────
  app.get<{ Querystring: { status?: string } }>('/admin/reports', admin, async req => {
    const m = req.member!;
    const status = parse(z.enum(['open', 'actioned', 'dismissed', 'all']).default('open'), req.query.status);
    const { rows } = await pool.query<{ id: string; target_type: ReportTarget; target_id: string; reason: string; details: string; status: string; created_at: Date; reporter: string; reports: number }>(
      `SELECT r.id, r.target_type, r.target_id, r.reason, r.details, r.status, r.created_at, u.name AS reporter,
              (SELECT count(*)::int FROM content_reports x WHERE x.target_type = r.target_type AND x.target_id = r.target_id) AS reports
         FROM content_reports r JOIN users u ON u.id = r.reporter_id
        WHERE r.university_id = $1 AND ($2 = 'all' OR r.status = $2) ORDER BY r.created_at DESC LIMIT 200`,
      [m.universityId, status],
    );
    const items = [];
    for (const r of rows) {
      const t = await describe(pool, r.target_type, r.target_id, m.universityId);
      items.push({ id: r.id, targetType: r.target_type, targetId: r.target_id, title: t?.title ?? '(already removed)', reason: r.reason, details: r.details, status: r.status, reporter: r.reporter, totalReports: r.reports, createdAt: ms(r.created_at) });
    }
    return { reports: items };
  });

  // "remove" hides or closes the item; "dismiss" says the report was not a problem.
  app.post<{ Params: { id: string } }>('/admin/reports/:id', admin, async req => {
    const m = req.member!;
    const { action } = parse(z.object({ action: z.enum(['remove', 'dismiss']) }), req.body);
    const { rows } = await pool.query<{ id: string; target_type: ReportTarget; target_id: string; status: string }>(
      'SELECT id, target_type, target_id, status FROM content_reports WHERE id = $1 AND university_id = $2',
      [uuid(req.params.id), m.universityId],
    );
    const r = rows[0];
    if (!r) {
      throw notFound('Report not found.');
    }
    if (r.status !== 'open') {
      throw conflict('This report was already handled.', 'already_handled');
    }
    if (action === 'remove') {
      await removeTarget(r.target_type, r.target_id, m.universityId, m.userId);
    }
    // Every open report about the same item is handled together.
    await pool.query(
      `UPDATE content_reports SET status = $3, handled_by = $4, handled_at = now()
        WHERE university_id = $1 AND target_type = $2 AND target_id = $5 AND status = 'open'`,
      [m.universityId, r.target_type, action === 'remove' ? 'actioned' : 'dismissed', m.userId, r.target_id],
    );
    return { ok: true };
  });

  async function removeTarget(type: ReportTarget, id: string, universityId: string, adminId: string) {
    const one = (sql: string) => pool.query(sql, [id, universityId]);
    switch (type) {
      case 'note':
        await one("UPDATE study_notes SET status = 'hidden' WHERE id = $1 AND university_id = $2");
        return;
      case 'book':
        await one("UPDATE books SET status = 'hidden' WHERE id = $1 AND university_id = $2");
        return;
      case 'study_group':
        await one("UPDATE study_groups SET status = 'closed' WHERE id = $1 AND university_id = $2");
        return;
      case 'job':
        await one("UPDATE jobs SET status = 'closed' WHERE id = $1 AND university_id = $2");
        return;
      case 'lost_item':
        await one('DELETE FROM lost_items WHERE id = $1 AND university_id = $2');
        return;
      case 'message':
        await one('DELETE FROM messages WHERE id = $1 AND university_id = $2');
        await emptyTrash(pool, storage); // a deleted message takes its picture or document with it
        return;
      case 'story':
        await removeStory(pool, storage, id, universityId);
        return;
      case 'photo': {
        const f = await pool.query<{ storage_key: string; thumb_key: string }>('DELETE FROM photos WHERE id = $1 AND university_id = $2 RETURNING storage_key, thumb_key', [id, universityId]);
        await Promise.all(f.rows.flatMap(x => [storage.delete(x.storage_key), storage.delete(x.thumb_key)]).map(p => p.catch(() => undefined)));
        return;
      }
      case 'user': {
        if (id === adminId) {
          throw forbidden('You cannot suspend yourself.');
        }
        await withTx(pool, async c => {
          await c.query("UPDATE memberships SET status = 'suspended' WHERE user_id = $1 AND university_id = $2 AND role NOT IN ('uni_admin')", [id, universityId]);
          await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
        });
      }
    }
  }
};

