import { z } from 'zod';

import { ADMIN_ROLES, POSTING_ROLES, type PostKind } from '../domain.js';
import type { Db } from '../db/pool.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { canManageSociety } from './societies.js';
import { ms, parse, uuid } from '../lib/http.js';
import type { Routes } from './types.js';

interface PostRow {
  id: string;
  university_id: string;
  kind: PostKind;
  title: string;
  body: string;
  author_id: string | null;
  author_name: string;
  author_role: string;
  source: string;
  channel: string | null;
  society_id: string | null;
  pinned: boolean;
  created_at: Date;
  like_count: number;
  comment_count: number;
  read_count: number;
}

const SELECT = `
  SELECT p.*,
         (SELECT count(*)::int FROM post_likes l WHERE l.post_id = p.id)    AS like_count,
         (SELECT count(*)::int FROM post_comments c WHERE c.post_id = p.id) AS comment_count,
         (SELECT count(*)::int FROM post_reads r WHERE r.post_id = p.id)    AS read_count
    FROM posts p`;

const dto = (p: PostRow) => ({
  id: p.id,
  universityId: p.university_id,
  kind: p.kind,
  title: p.title,
  body: p.body,
  authorId: p.author_id ?? '',
  authorName: p.author_name,
  authorRole: p.author_role,
  source: p.source,
  channel: p.channel,
  societyId: p.society_id,
  pinned: p.pinned,
  createdAt: ms(p.created_at),
  likeCount: p.like_count,
  commentCount: p.comment_count,
  readCount: p.read_count,
});

/** A post of MY university, or 404. Posts of other universities look like they do not exist. */
async function loadPost(db: Db, id: string, universityId: string): Promise<PostRow> {
  const { rows } = await db.query<PostRow>(`${SELECT} WHERE p.id = $1 AND p.university_id = $2`, [id, universityId]);
  if (!rows[0]) {
    throw notFound('Update not found.');
  }
  return rows[0];
}

const createSchema = z.object({
  kind: z.enum(['official', 'society', 'alert']),
  title: z.string().trim().min(3).max(120),
  body: z.string().trim().min(10).max(4000),
  /** The byline. For society updates the server uses the society's own name instead. */
  source: z.string().trim().min(2).max(100).optional(),
  societyId: z.string().uuid().nullable().default(null),
  channel: z.string().trim().min(1).max(80).nullable().default(null),
  pinned: z.boolean().default(false),
});

export const postsRoutes: Routes = async (app, { deps, guards }) => {
  const { pool, push } = deps;
  const member = { preHandler: guards.member };

  app.get<{ Querystring: { limit?: string } }>('/posts', member, async req => {
    const m = req.member!;
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? '60', 10) || 60, 1), 200);
    const { rows } = await pool.query<PostRow>(`${SELECT} WHERE p.university_id = $1 ORDER BY p.created_at DESC LIMIT $2`, [m.universityId, limit]);
    const ids = rows.map(r => r.id);
    const [liked, saved] = await Promise.all([
      pool.query<{ post_id: string }>('SELECT post_id FROM post_likes WHERE user_id = $1 AND post_id = ANY($2::uuid[])', [m.userId, ids]),
      pool.query<{ post_id: string }>('SELECT post_id FROM post_bookmarks WHERE user_id = $1 AND post_id = ANY($2::uuid[])', [m.userId, ids]),
    ]);
    return {
      posts: rows.map(dto),
      state: { liked: liked.rows.map(r => r.post_id), bookmarked: saved.rows.map(r => r.post_id) },
    };
  });

  app.post('/posts', member, async (req, reply) => {
    const m = req.member!;
    const body = parse(createSchema, req.body);

    if (!POSTING_ROLES[body.kind].includes(m.role)) {
      throw forbidden('Your role cannot publish this kind of update.');
    }
    if (body.pinned && (!ADMIN_ROLES.includes(m.role) || body.kind === 'alert')) {
      throw forbidden('Only admins can pin updates, and alerts cannot be pinned.');
    }
    let source = body.source ?? '';
    let societyId: string | null = null;
    if (body.kind === 'society') {
      if (!body.societyId) {
        throw badRequest('Choose the society this update is from.');
      }
      if (!(await canManageSociety(pool, body.societyId, m.universityId, m.userId, m.role))) {
        throw forbidden('Only the head of this society (or an admin) can post for it.');
      }
      const name = await pool.query<{ name: string }>('SELECT name FROM societies WHERE id = $1', [body.societyId]);
      source = name.rows[0]?.name ?? source;
      societyId = body.societyId;
    } else {
      if (body.societyId) {
        throw badRequest('Only society updates can belong to a society.');
      }
      if (!source) {
        throw badRequest('Say who is posting this update.');
      }
    }
    if (body.channel) {
      const ok = await pool.query('SELECT 1 FROM departments WHERE university_id = $1 AND name = $2', [m.universityId, body.channel]);
      if (ok.rowCount === 0) {
        throw badRequest('That department channel does not exist.');
      }
    }

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO posts (university_id, kind, title, body, author_id, author_name, author_role, source, channel, pinned, society_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [m.universityId, body.kind, body.title, body.body, m.userId, req.user!.name, m.role, source, body.channel, body.pinned, societyId],
    );
    const post = await loadPost(pool, (rows[0] as { id: string }).id, m.universityId);

    // Tell everyone it concerns (the whole university, or one department's channel), except the author.
    const audience = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM memberships
        WHERE university_id = $1 AND status = 'active' AND user_id <> $2
          AND ($3::text IS NULL OR department = $3)`,
      [m.universityId, m.userId, body.channel],
    );
    await push.sendToUsers(
      audience.rows.map(r => r.user_id),
      {
        title: body.kind === 'alert' ? `Alert: ${body.title}` : body.title,
        body: `${source}: ${body.body}`.slice(0, 140),
        data: { kind: body.kind, postId: post.id },
        urgent: body.kind === 'alert',
      },
    );
    return reply.status(201).send(dto(post));
  });

  app.delete<{ Params: { id: string } }>('/posts/:id', member, async (req, reply) => {
    const m = req.member!;
    const post = await loadPost(pool, uuid(req.params.id), m.universityId);
    if (!ADMIN_ROLES.includes(m.role) && post.author_id !== m.userId) {
      throw forbidden();
    }
    await pool.query('DELETE FROM posts WHERE id = $1', [post.id]);
    return reply.status(204).send();
  });

  // ── likes, bookmarks, reads ────────────────────────────────────────────────

  const toggle = (table: 'post_likes' | 'post_bookmarks', on: boolean) =>
    async (req: { member?: { universityId: string; userId: string } | null; params: { id: string } }) => {
      const m = req.member!;
      const post = await loadPost(pool, uuid(req.params.id), m.universityId);
      if (on) {
        await pool.query(`INSERT INTO ${table} (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [post.id, m.userId]);
      } else {
        await pool.query(`DELETE FROM ${table} WHERE post_id = $1 AND user_id = $2`, [post.id, m.userId]);
      }
      return dto(await loadPost(pool, post.id, m.universityId));
    };

  app.put<{ Params: { id: string } }>('/posts/:id/like', member, toggle('post_likes', true));
  app.delete<{ Params: { id: string } }>('/posts/:id/like', member, toggle('post_likes', false));
  app.put<{ Params: { id: string } }>('/posts/:id/bookmark', member, toggle('post_bookmarks', true));
  app.delete<{ Params: { id: string } }>('/posts/:id/bookmark', member, toggle('post_bookmarks', false));

  // "Seen by N": counted once per student.
  app.post<{ Params: { id: string } }>('/posts/:id/read', member, async (req, reply) => {
    const m = req.member!;
    const post = await loadPost(pool, uuid(req.params.id), m.universityId);
    await pool.query('INSERT INTO post_reads (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [post.id, m.userId]);
    return reply.status(204).send();
  });

  // ── comments ───────────────────────────────────────────────────────────────

  interface CommentRow {
    id: string;
    post_id: string;
    author_id: string | null;
    author_name: string;
    text: string;
    created_at: Date;
  }
  const commentDto = (c: CommentRow) => ({
    id: c.id,
    postId: c.post_id,
    authorId: c.author_id ?? '',
    authorName: c.author_name,
    text: c.text,
    createdAt: ms(c.created_at),
  });

  app.get<{ Params: { id: string } }>('/posts/:id/comments', member, async req => {
    const m = req.member!;
    const post = await loadPost(pool, uuid(req.params.id), m.universityId);
    const { rows } = await pool.query<CommentRow>('SELECT * FROM post_comments WHERE post_id = $1 ORDER BY created_at LIMIT 300', [post.id]);
    return { comments: rows.map(commentDto) };
  });

  app.post<{ Params: { id: string } }>('/posts/:id/comments', member, async (req, reply) => {
    const m = req.member!;
    const post = await loadPost(pool, uuid(req.params.id), m.universityId);
    const { text } = parse(z.object({ text: z.string().trim().min(1).max(500) }), req.body);
    const { rows } = await pool.query<CommentRow>(
      'INSERT INTO post_comments (post_id, author_id, author_name, text) VALUES ($1, $2, $3, $4) RETURNING *',
      [post.id, m.userId, req.user!.name, text],
    );
    return reply.status(201).send(commentDto(rows[0] as CommentRow));
  });

  app.delete<{ Params: { id: string; commentId: string } }>('/posts/:id/comments/:commentId', member, async (req, reply) => {
    const m = req.member!;
    const post = await loadPost(pool, uuid(req.params.id), m.universityId);
    const { rows } = await pool.query<{ author_id: string | null }>('SELECT author_id FROM post_comments WHERE id = $1 AND post_id = $2', [uuid(req.params.commentId), post.id]);
    if (!rows[0]) {
      throw notFound('Comment not found.');
    }
    if (!ADMIN_ROLES.includes(m.role) && rows[0].author_id !== m.userId) {
      throw forbidden();
    }
    await pool.query('DELETE FROM post_comments WHERE id = $1', [req.params.commentId]);
    return reply.status(204).send();
  });
};
