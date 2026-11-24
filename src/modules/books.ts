import { z } from 'zod';

import { ADMIN_ROLES } from '../domain.js';
import { withTx } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { ms, parse, uuid } from '../lib/http.js';
import { signedPath } from '../media/signedUrl.js';
import type { Routes } from './types.js';

const CONDITIONS = ['new', 'like_new', 'good', 'fair'] as const;

interface BookRow {
  id: string;
  title: string;
  author: string;
  course: string;
  price: number;
  condition: string;
  description: string;
  status: string;
  seller_id: string;
  seller_name: string;
  created_at: Date;
  photos: { id: string; width: number; height: number }[];
  interested: number;
  i_asked: boolean;
}

const SELECT = `
  SELECT b.id, b.title, b.author, b.course, b.price, b.condition, b.description, b.status, b.seller_id, u.name AS seller_name, b.created_at,
    COALESCE((SELECT json_agg(json_build_object('id', m.id, 'width', m.width, 'height', m.height) ORDER BY bp.position)
                FROM book_photos bp JOIN media m ON m.id = bp.media_id WHERE bp.book_id = b.id), '[]'::json) AS photos,
    (SELECT count(*)::int FROM book_interest i WHERE i.book_id = b.id) AS interested,
    EXISTS (SELECT 1 FROM book_interest i WHERE i.book_id = b.id AND i.user_id = $2) AS i_asked
  FROM books b JOIN users u ON u.id = b.seller_id`;

const likeEscape = (s: string) => s.replace(/[\\%_]/g, c => `\\${c}`);

const fields = {
  title: z.string().trim().min(2).max(120),
  author: z.string().trim().max(80),
  course: z.string().trim().max(60),
  price: z.number().int().min(0).max(1_000_000),
  condition: z.enum(CONDITIONS),
  description: z.string().trim().max(500),
};

export const booksRoutes: Routes = async (app, { deps, guards }) => {
  const { config, pool, push, storage } = deps;
  const member = { preHandler: guards.member };

  const dto = (b: BookRow, viewerId: string, isAdmin: boolean) => ({
    id: b.id,
    title: b.title,
    author: b.author,
    course: b.course,
    price: b.price,
    condition: b.condition,
    description: b.description,
    status: b.status,
    sellerName: b.seller_name,
    mine: b.seller_id === viewerId,
    canManage: b.seller_id === viewerId || isAdmin,
    photos: b.photos.map(p => ({ id: p.id, url: signedPath(config, 'media', p.id, 'full'), thumbUrl: signedPath(config, 'media', p.id, 'thumb'), width: p.width, height: p.height })),
    // Only the seller (and admins) see how many people asked.
    interestedCount: b.seller_id === viewerId || isAdmin ? b.interested : null,
    iAsked: b.i_asked,
    createdAt: ms(b.created_at),
  });

  async function load(id: string, universityId: string, viewerId: string, isAdmin: boolean): Promise<BookRow> {
    const { rows } = await pool.query<BookRow>(`${SELECT} WHERE b.id = $1 AND b.university_id = $3`, [id, viewerId, universityId]);
    const b = rows[0];
    if (!b || (b.status === 'hidden' && b.seller_id !== viewerId && !isAdmin)) {
      throw notFound('Book not found.');
    }
    return b;
  }

  app.get<{ Querystring: { q?: string; scope?: string; course?: string } }>('/books', member, async req => {
    const m = req.member!;
    const isAdmin = ADMIN_ROLES.includes(m.role);
    const q = parse(z.object({ q: z.string().trim().max(60).optional(), scope: z.enum(['market', 'mine']).default('market'), course: z.string().trim().max(60).optional() }), req.query);
    const { rows } = await pool.query<BookRow>(
      `${SELECT}
        WHERE b.university_id = $1
          AND (($3 = 'market' AND b.status IN ('available', 'reserved')) OR ($3 = 'mine' AND b.seller_id = $2))
          AND ($4::text IS NULL OR b.title ILIKE $4 OR b.author ILIKE $4 OR b.course ILIKE $4)
          AND ($5::text IS NULL OR lower(b.course) = lower($5))
        ORDER BY b.created_at DESC LIMIT 100`,
      [m.universityId, m.userId, q.scope, q.q ? `%${likeEscape(q.q)}%` : null, q.course ?? null],
    );
    return { books: rows.map(b => dto(b, m.userId, isAdmin)) };
  });

  app.get<{ Params: { id: string } }>('/books/:id', member, async req => {
    const m = req.member!;
    return dto(await load(uuid(req.params.id), m.universityId, m.userId, ADMIN_ROLES.includes(m.role)), m.userId, ADMIN_ROLES.includes(m.role));
  });

  app.post('/books', { preHandler: guards.member, config: { rateLimit: { max: config.nodeEnv === 'test' ? 100_000 : 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    const m = req.member!;
    const b = parse(z.object({ ...fields, author: fields.author.default(''), course: fields.course.default(''), description: fields.description.default(''), mediaIds: z.array(z.string().uuid()).max(3).default([]) }), req.body);
    const id = await withTx(pool, async c => {
      if (b.mediaIds.length > 0) {
        const ok = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM media mm WHERE mm.id = ANY($1::uuid[]) AND mm.owner_id = $2 AND mm.university_id = $3
              AND NOT EXISTS (SELECT 1 FROM book_photos bp WHERE bp.media_id = mm.id)`,
          [b.mediaIds, m.userId, m.universityId],
        );
        if ((ok.rows[0]?.n ?? 0) !== new Set(b.mediaIds).size) {
          throw badRequest('One of the pictures is not yours or was already used.');
        }
      }
      const ins = await c.query<{ id: string }>(
        'INSERT INTO books (university_id, seller_id, title, author, course, price, condition, description) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
        [m.universityId, m.userId, b.title, b.author, b.course, b.price, b.condition, b.description],
      );
      const bookId = (ins.rows[0] as { id: string }).id;
      for (const [i, mediaId] of [...new Set(b.mediaIds)].entries()) {
        await c.query('INSERT INTO book_photos (book_id, media_id, university_id, position) VALUES ($1, $2, $3, $4)', [bookId, mediaId, m.universityId, i]);
      }
      return bookId;
    });
    return reply.status(201).send(dto(await load(id, m.universityId, m.userId, false), m.userId, ADMIN_ROLES.includes(m.role)));
  });

  app.patch<{ Params: { id: string } }>('/books/:id', member, async req => {
    const m = req.member!;
    const isAdmin = ADMIN_ROLES.includes(m.role);
    const b = parse(z.object({ title: fields.title.optional(), author: fields.author.optional(), course: fields.course.optional(), price: fields.price.optional(), condition: fields.condition.optional(), description: fields.description.optional(), status: z.enum(['available', 'reserved', 'sold']).optional() }), req.body);
    const book = await load(uuid(req.params.id), m.universityId, m.userId, isAdmin);
    if (book.seller_id !== m.userId) {
      throw forbidden('Only the seller can change this listing.');
    }
    if (book.status === 'hidden') {
      throw forbidden('An admin hid this listing.');
    }
    await pool.query(
      `UPDATE books SET title = COALESCE($2, title), author = COALESCE($3, author), course = COALESCE($4, course), price = COALESCE($5, price),
                        condition = COALESCE($6, condition), description = COALESCE($7, description), status = COALESCE($8, status)
        WHERE id = $1`,
      [book.id, b.title ?? null, b.author ?? null, b.course ?? null, b.price ?? null, b.condition ?? null, b.description ?? null, b.status ?? null],
    );
    return dto(await load(book.id, m.universityId, m.userId, isAdmin), m.userId, isAdmin);
  });

  app.delete<{ Params: { id: string } }>('/books/:id', member, async (req, reply) => {
    const m = req.member!;
    const isAdmin = ADMIN_ROLES.includes(m.role);
    const book = await load(uuid(req.params.id), m.universityId, m.userId, isAdmin);
    if (book.seller_id !== m.userId && !isAdmin) {
      throw forbidden('Only the seller (or an admin) can remove this listing.');
    }
    const files = await pool.query<{ storage_key: string; thumb_key: string }>(
      'SELECT mm.storage_key, mm.thumb_key FROM book_photos bp JOIN media mm ON mm.id = bp.media_id WHERE bp.book_id = $1',
      [book.id],
    );
    await pool.query('DELETE FROM media WHERE id IN (SELECT media_id FROM book_photos WHERE book_id = $1)', [book.id]);
    await pool.query('DELETE FROM books WHERE id = $1', [book.id]);
    await Promise.all(files.rows.flatMap(f => [storage.delete(f.storage_key), storage.delete(f.thumb_key)]).map(p => p.catch(() => undefined)));
    return reply.status(204).send();
  });

  // "I want it": tells the seller once. Buyer and seller then meet on campus.
  app.post<{ Params: { id: string } }>('/books/:id/interest', { preHandler: guards.member, config: { rateLimit: { max: config.nodeEnv === 'test' ? 100_000 : 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    const m = req.member!;
    const book = await load(uuid(req.params.id), m.universityId, m.userId, false);
    if (book.seller_id === m.userId) {
      throw forbidden('This is your own listing.');
    }
    if (book.status !== 'available') {
      throw conflict('This book is no longer available.', 'not_available');
    }
    const ins = await pool.query('INSERT INTO book_interest (book_id, university_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [book.id, m.universityId, m.userId]);
    if (ins.rowCount) {
      await push.sendToUsers([book.seller_id], {
        title: 'Someone wants your book',
        body: `${req.user!.name} is interested in "${book.title}". Open Book market to see who.`,
        data: { kind: 'official' },
      });
    }
    return reply.status(200).send({ ok: true });
  });

  app.get<{ Params: { id: string } }>('/books/:id/interested', member, async req => {
    const m = req.member!;
    const isAdmin = ADMIN_ROLES.includes(m.role);
    const book = await load(uuid(req.params.id), m.universityId, m.userId, isAdmin);
    if (book.seller_id !== m.userId && !isAdmin) {
      throw forbidden();
    }
    const { rows } = await pool.query<{ id: string; name: string; department: string; batch: string; created_at: Date }>(
      `SELECT u.id, u.name, mem.department, mem.batch, i.created_at
         FROM book_interest i JOIN users u ON u.id = i.user_id JOIN memberships mem ON mem.user_id = i.user_id
        WHERE i.book_id = $1 ORDER BY i.created_at`,
      [book.id],
    );
    return { interested: rows.map(r => ({ uid: r.id, name: r.name, department: r.department, batch: r.batch, createdAt: ms(r.created_at) })) };
  });
};
