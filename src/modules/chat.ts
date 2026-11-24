import { randomUUID } from 'node:crypto';

import multipart from '@fastify/multipart';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { withTx, type Db } from '../db/pool.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { ms, parse, uuid } from '../lib/http.js';
import { readMultipart } from '../lib/multipart.js';
import { MAX_UPLOAD_BYTES, processImage } from '../media/image.js';
import { signedPath, verifySignature } from '../media/signedUrl.js';
import { emptyTrash } from '../media/trash.js';
import type { Routes } from './types.js';

export interface ConvRow {
  id: string;
  kind: 'dm' | 'society' | 'group' | 'custom';
  user_a: string | null;
  user_b: string | null;
  society_id: string | null;
  group_id: string | null;
  /** Groups people made themselves: the group name, my role, and when I joined (I see nothing older). */
  name: string | null;
  only_admins_post: boolean;
  my_role: 'member' | 'admin' | null;
  joined_at: Date | null;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, c => `\\${c}`);

/** The reactions people can use (like WhatsApp's quick row). */
export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_DAY = 100;
const DELETE_FOR_EVERYONE_MS = 2 * 24 * 3_600_000;

const OFFICE: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/**
 * Is this a document we accept? A PDF must start with "%PDF-"; a Word, Excel or PowerPoint file is a zip
 * ("PK") with the matching extension. Anything else (including executables) is not accepted as a document.
 * The file is stored under a name WE choose and is only ever served as a download.
 */
export function detectDocument(data: Buffer, originalName: string): { ext: string; mime: string } | null {
  if (data.subarray(0, 5).toString('latin1') === '%PDF-') {
    return { ext: 'pdf', mime: 'application/pdf' };
  }
  const ext = originalName.toLowerCase().split('.').pop() ?? '';
  if (OFFICE[ext] && data.length > 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) {
    return { ext, mime: OFFICE[ext] as string };
  }
  return null;
}

/** A name that is safe to show and to put in a download header. */
const cleanName = (raw: string, ext: string): string => {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f"<>|:*?]/g, '').trim().slice(0, 100);
  return cleaned.length > 0 ? cleaned : `file.${ext}`;
};

/** The conversation, if this person may use it (null otherwise). The single place that decides who can read a chat. */
export async function findAccessible(db: Db, id: string, universityId: string, userId: string): Promise<ConvRow | null> {
  const { rows } = await db.query<ConvRow>(
    `SELECT c.id, c.kind, c.user_a, c.user_b, c.society_id, c.group_id, c.name, c.only_admins_post, cm.role AS my_role, cm.joined_at
       FROM conversations c
       LEFT JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $3
      WHERE c.id = $1 AND c.university_id = $2
        AND ((c.kind = 'dm' AND $3 IN (c.user_a, c.user_b))
          OR (c.kind = 'custom' AND cm.user_id IS NOT NULL)
          OR (c.kind = 'society' AND EXISTS (SELECT 1 FROM society_members sm WHERE sm.society_id = c.society_id AND sm.user_id = $3))
          OR (c.kind = 'group' AND EXISTS (SELECT 1 FROM study_group_members gm WHERE gm.group_id = c.group_id AND gm.user_id = $3)))`,
    [id, universityId, userId],
  );
  return rows[0] ?? null;
}

/** Everybody in the conversation except `except`. */
export async function audienceOf(db: Db, conv: ConvRow, except: string): Promise<string[]> {
  if (conv.kind === 'dm') {
    return [conv.user_a === except ? conv.user_b : conv.user_a].filter((u): u is string => u !== null);
  }
  const sql: Record<string, [string, unknown]> = {
    society: ['SELECT user_id FROM society_members WHERE society_id = $1', conv.society_id],
    group: ['SELECT user_id FROM study_group_members WHERE group_id = $1', conv.group_id],
    custom: ['SELECT user_id FROM conversation_members WHERE conversation_id = $1', conv.id],
  };
  const [text, arg] = sql[conv.kind]!;
  return (await db.query<{ user_id: string }>(text, [arg])).rows.map(r => r.user_id).filter(u => u !== except);
}

/**
 * Chat. A conversation is one of: a one-to-one chat, a society's room (members only), a study group's room
 * (members only) or a group students made themselves. Who can read a room is decided by the rows that already say
 * who belongs to it, so there is no second list to keep in step. The app is nudged over a WebSocket when something
 * new arrives (see realtime) and asks the normal endpoints for the content.
 */
export const chatRoutes: Routes = async (app, { deps, guards }) => {
  const { config, pool, push, hub, storage } = deps;
  const member = { preHandler: guards.member };
  const limit = (max: number) => ({ config: { rateLimit: { max: config.nodeEnv === 'test' ? 100_000 : max, timeWindow: '1 minute' } } });

  await app.register(multipart, { limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 4, parts: 6 } });

  /** Is either person blocking the other? */
  async function blocked(db: Db, a: string, b: string): Promise<boolean> {
    const r = await db.query('SELECT 1 FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)', [a, b]);
    return (r.rowCount ?? 0) > 0;
  }

  /** The conversation, if this person may use it. Otherwise "not found" (never reveals that it exists). */
  async function access(db: Db, id: string, universityId: string, userId: string): Promise<ConvRow> {
    const conv = await findAccessible(db, id, universityId, userId);
    if (!conv) {
      throw notFound('Conversation not found.');
    }
    return conv;
  }

  async function room(kind: 'society' | 'group', targetId: string, universityId: string): Promise<string> {
    const col = kind === 'society' ? 'society_id' : 'group_id';
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO conversations (university_id, kind, ${col}) VALUES ($1, $2, $3)
       ON CONFLICT (${col}) WHERE kind = '${kind}' DO UPDATE SET kind = conversations.kind RETURNING id`,
      [universityId, kind, targetId],
    );
    return (rows[0] as { id: string }).id;
  }

  // -- list -------------------------------------------------------------------
  app.get('/chats', member, async req => {
    const m = req.member!;
    // Make sure every society and group I belong to has its room.
    const [socs, grps] = await Promise.all([
      pool.query<{ id: string }>('SELECT society_id AS id FROM society_members WHERE user_id = $1', [m.userId]),
      pool.query<{ id: string }>('SELECT group_id AS id FROM study_group_members WHERE user_id = $1', [m.userId]),
    ]);
    await Promise.all([...socs.rows.map(s => room('society', s.id, m.universityId)), ...grps.rows.map(g => room('group', g.id, m.universityId))]);

    const { rows } = await pool.query<{
      id: string; kind: string; title: string; other_id: string | null; other_photo: string | null; society_id: string | null; group_id: string | null; last_body: string | null; last_at: Date | null; last_sender: string | null; unread: number; members: number | null;
    }>(
      `SELECT c.id, c.kind, c.society_id, c.group_id,
              CASE c.kind WHEN 'dm' THEN ou.name WHEN 'society' THEN s.name WHEN 'custom' THEN c.name ELSE g.title END AS title,
              CASE WHEN c.kind = 'dm' THEN ou.id END AS other_id,
              CASE WHEN c.kind = 'dm' THEN ou.photo_url END AS other_photo,
              lm.body AS last_body, lm.created_at AS last_at, lu.name AS last_sender,
              (SELECT count(*)::int FROM messages x
                WHERE x.conversation_id = c.id AND x.sender_id <> $2 AND x.kind = 'text'
                  AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = x.id AND h.user_id = $2)
                  AND x.created_at >= COALESCE(cmj.joined_at, 'epoch')
                  AND x.created_at > COALESCE((SELECT last_read_at FROM conversation_reads r WHERE r.conversation_id = c.id AND r.user_id = $2), 'epoch')) AS unread,
              CASE c.kind WHEN 'society' THEN (SELECT count(*)::int FROM society_members WHERE society_id = c.society_id)
                          WHEN 'group' THEN (SELECT count(*)::int FROM study_group_members WHERE group_id = c.group_id)
                          WHEN 'custom' THEN (SELECT count(*)::int FROM conversation_members WHERE conversation_id = c.id) END AS members
         FROM conversations c
         LEFT JOIN conversation_members cmj ON cmj.conversation_id = c.id AND cmj.user_id = $2
         LEFT JOIN users ou ON c.kind = 'dm' AND ou.id = CASE WHEN c.user_a = $2 THEN c.user_b ELSE c.user_a END
         LEFT JOIN societies s ON s.id = c.society_id
         LEFT JOIN study_groups g ON g.id = c.group_id
         LEFT JOIN LATERAL (
           SELECT CASE WHEN x.deleted_at IS NOT NULL THEN '🚫 This message was deleted'
                       WHEN x.body <> '' THEN x.body
                       WHEN at.kind = 'image' THEN '📷 Photo'
                       ELSE '📄 ' || COALESCE(at.name, 'Document') END AS body,
                  x.created_at, x.sender_id
             FROM messages x LEFT JOIN message_attachments at ON at.message_id = x.id
            WHERE x.conversation_id = c.id AND x.created_at >= COALESCE(cmj.joined_at, 'epoch')
              AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = x.id AND h.user_id = $2)
            ORDER BY x.created_at DESC LIMIT 1) lm ON true
         LEFT JOIN users lu ON lu.id = lm.sender_id
        WHERE c.university_id = $1
          AND ((c.kind = 'dm' AND $2 IN (c.user_a, c.user_b)
                AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = c.user_a AND b.blocked_id = c.user_b) OR (b.blocker_id = c.user_b AND b.blocked_id = c.user_a))
                AND (lm.body IS NOT NULL))
            OR (c.kind = 'custom' AND cmj.user_id IS NOT NULL)
            OR (c.kind = 'society' AND EXISTS (SELECT 1 FROM society_members sm WHERE sm.society_id = c.society_id AND sm.user_id = $2))
            OR (c.kind = 'group' AND EXISTS (SELECT 1 FROM study_group_members gm WHERE gm.group_id = c.group_id AND gm.user_id = $2)))
        ORDER BY COALESCE(lm.created_at, c.created_at) DESC LIMIT 100`,
      [m.universityId, m.userId],
    );
    return {
      chats: rows.map(r => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        otherUserId: r.other_id,
        otherPhotoUrl: r.other_photo,
        targetId: r.kind === 'society' ? r.society_id : r.kind === 'group' ? r.group_id : null,
        memberCount: r.members,
        lastMessage: r.last_body ? { body: r.last_body, at: ms(r.last_at), sender: r.last_sender } : null,
        unread: r.unread,
      })),
    };
  });

  // The room of a society or study group I belong to.
  for (const kind of ['society', 'group'] as const) {
    app.get<{ Params: { id: string } }>(`/chats/${kind}/:id`, member, async req => {
      const m = req.member!;
      const targetId = uuid(req.params.id);
      const isIn = kind === 'society'
        ? await pool.query('SELECT s.name AS title FROM society_members sm JOIN societies s ON s.id = sm.society_id WHERE sm.society_id = $1 AND sm.user_id = $2 AND s.university_id = $3', [targetId, m.userId, m.universityId])
        : await pool.query('SELECT g.title FROM study_group_members gm JOIN study_groups g ON g.id = gm.group_id WHERE gm.group_id = $1 AND gm.user_id = $2 AND g.university_id = $3', [targetId, m.userId, m.universityId]);
      const row = isIn.rows[0] as { title: string } | undefined;
      if (!row) {
        throw forbidden('Join first to open the chat.');
      }
      return { id: await room(kind, targetId, m.universityId), title: row.title };
    });
  }

  // -- people (to start a chat) ----------------------------------------------
  app.get<{ Querystring: { q?: string } }>('/people', member, async req => {
    const m = req.member!;
    // Without a search word this is the whole contact list (everyone at the university, A to Z).
    const q = parse(z.object({ q: z.string().trim().max(60).optional() }), req.query).q ?? '';
    const { rows } = await pool.query<{ id: string; name: string; photo_url: string | null; department: string; batch: string }>(
      `SELECT u.id, u.name, u.photo_url, mem.department, mem.batch FROM memberships mem JOIN users u ON u.id = mem.user_id
        WHERE mem.university_id = $1 AND mem.status = 'active' AND mem.user_id <> $2 AND u.name ILIKE $3
          AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $2 AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = $2))
        ORDER BY u.name LIMIT 200`,
      [m.universityId, m.userId, `%${likeEscape(q)}%`],
    );
    return { people: rows.map(r => ({ uid: r.id, name: r.name, photoUrl: r.photo_url, department: r.department, batch: r.batch })) };
  });

  // One person's public card (what you see when you tap their name in a chat). No email, no student ID.
  app.get<{ Params: { id: string } }>('/people/:id', member, async req => {
    const m = req.member!;
    const id = uuid(req.params.id);
    const who = await pool.query<{ name: string; photo_url: string | null; department: string; role: string; created_at: Date }>(
      `SELECT u.name, u.photo_url, mem.department, mem.role, mem.created_at
         FROM memberships mem JOIN users u ON u.id = mem.user_id
        WHERE mem.user_id = $1 AND mem.university_id = $2 AND mem.status = 'active'`,
      [id, m.universityId],
    );
    const p = who.rows[0];
    if (!p || (await blocked(pool, m.userId, id))) {
      throw notFound('That person was not found.');
    }
    const soc = await pool.query<{ id: string; name: string; role: string }>(
      `SELECT s.id, s.name, sm.role FROM society_members sm JOIN societies s ON s.id = sm.society_id
        WHERE sm.user_id = $1 AND s.university_id = $2 ORDER BY (sm.role = 'head') DESC, s.name`,
      [id, m.universityId],
    );
    return {
      uid: id,
      name: p.name,
      photoUrl: p.photo_url,
      department: p.department,
      role: p.role,
      joinedAt: ms(p.created_at),
      societies: soc.rows.map(s => ({ id: s.id, name: s.name, head: s.role === 'head' })),
    };
  });

  // -- start / find a one-to-one chat -----------------------------------------
  app.post('/chats/dm', member, async (req, reply) => {
    const m = req.member!;
    const { userId } = parse(z.object({ userId: z.string().uuid() }), req.body);
    if (userId === m.userId) {
      throw badRequest('You cannot message yourself.');
    }
    const other = await pool.query<{ name: string }>(
      `SELECT u.name FROM memberships mem JOIN users u ON u.id = mem.user_id WHERE mem.user_id = $1 AND mem.university_id = $2 AND mem.status = 'active'`,
      [userId, m.universityId],
    );
    if (!other.rows[0]) {
      throw notFound('That student was not found.');
    }
    if (await blocked(pool, m.userId, userId)) {
      throw forbidden('You cannot message this person.');
    }
    const [a, b] = m.userId < userId ? [m.userId, userId] : [userId, m.userId];
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO conversations (university_id, kind, user_a, user_b) VALUES ($1, 'dm', $2, $3)
       ON CONFLICT (university_id, user_a, user_b) WHERE kind = 'dm' DO UPDATE SET kind = conversations.kind RETURNING id`,
      [m.universityId, a, b],
    );
    return reply.status(200).send({ id: (rows[0] as { id: string }).id, title: other.rows[0].name });
  });

  // ── messages ───────────────────────────────────────────────────────────────

  interface MessageRow {
    id: string;
    sender_id: string;
    name: string;
    body: string;
    created_at: Date;
    att_id: string | null;
    att_kind: 'image' | 'file' | null;
    att_name: string | null;
    att_mime: string | null;
    att_bytes: number | null;
    att_width: number | null;
    att_height: number | null;
    kind: 'text' | 'system';
    deleted_at: Date | null;
    rt_id: string | null;
    rt_name: string | null;
    rt_body: string | null;
    rt_att_kind: 'image' | 'file' | null;
    rt_deleted: Date | null;
    reactions: { emoji: string; count: number; mine: boolean }[];
  }

  /** The columns of a message, with its attachment and its reactions (`$me` is the placeholder holding my user id). */
  const messageColumns = (me: string) => `
    x.id, x.sender_id, u.name, x.body, x.created_at,
    a.id AS att_id, a.kind AS att_kind, a.name AS att_name, a.mime AS att_mime, a.bytes AS att_bytes, a.width AS att_width, a.height AS att_height,
    x.kind, x.deleted_at, rm.id AS rt_id, ru.name AS rt_name, rm.body AS rt_body, ra.kind AS rt_att_kind, rm.deleted_at AS rt_deleted,
    COALESCE((SELECT json_agg(json_build_object('emoji', r.emoji, 'count', r.n, 'mine', r.mine) ORDER BY r.first_at)
                FROM (SELECT emoji, count(*)::int AS n, bool_or(user_id = ${me}) AS mine, min(created_at) AS first_at
                        FROM message_reactions WHERE message_id = x.id GROUP BY emoji) r), '[]'::json) AS reactions`;
  const messageFrom = `FROM messages x JOIN users u ON u.id = x.sender_id LEFT JOIN message_attachments a ON a.message_id = x.id
    LEFT JOIN messages rm ON rm.id = x.reply_to LEFT JOIN users ru ON ru.id = rm.sender_id LEFT JOIN message_attachments ra ON ra.message_id = rm.id`;

  const messageDto = (r: MessageRow, me: string) => ({
    id: r.id,
    kind: r.kind,
    senderId: r.sender_id,
    senderName: r.name,
    // A message deleted for everyone keeps its place but loses its content.
    body: r.deleted_at ? '' : r.body,
    deleted: r.deleted_at !== null,
    createdAt: ms(r.created_at),
    mine: r.sender_id === me,
    replyTo:
      r.rt_id && !r.deleted_at
        ? { id: r.rt_id, senderName: r.rt_name ?? '', body: r.rt_deleted ? '' : (r.rt_body ?? '').slice(0, 200), attachmentKind: r.rt_deleted ? null : r.rt_att_kind, deleted: r.rt_deleted !== null }
        : null,
    attachment: r.att_id && !r.deleted_at
      ? {
          kind: r.att_kind,
          name: r.att_name,
          mime: r.att_mime,
          bytes: r.att_bytes,
          url: signedPath(config, 'chat', r.att_id, r.att_kind === 'image' ? 'full' : 'file'),
          thumbUrl: r.att_kind === 'image' ? signedPath(config, 'chat', r.att_id, 'thumb') : null,
          width: r.att_width,
          height: r.att_height,
        }
      : null,
    reactions: r.deleted_at ? [] : r.reactions,
  });

  async function loadMessage(id: string, me: string): Promise<ReturnType<typeof messageDto>> {
    const { rows } = await pool.query<MessageRow>(`SELECT ${messageColumns('$2')} ${messageFrom} WHERE x.id = $1`, [id, me]);
    return messageDto(rows[0] as MessageRow, me);
  }

  /** Everybody who should hear about a change in this conversation, except `except`. */
  const audience = (conv: ConvRow, except: string) => audienceOf(pool, conv, except);

  /**
   * The ticks. For a one-to-one chat or a group the students made: how far everybody else has read, and how far
   * their phones have received it. (Society and study-group rooms are big and show no ticks.)
   */
  async function receiptsFor(conv: ConvRow, me: string): Promise<{ deliveredAt: number; readAt: number } | null> {
    if (conv.kind !== 'dm' && conv.kind !== 'custom') {
      return null;
    }
    const others = await audience(conv, me);
    if (others.length === 0) {
      return { deliveredAt: 0, readAt: 0 };
    }
    const { rows } = await pool.query<{ read_at: Date; delivered_at: Date }>(
      `SELECT min(COALESCE(r.last_read_at, 'epoch')) AS read_at,
              min(GREATEST(COALESCE(r.last_read_at, 'epoch'), COALESCE(r.last_delivered_at, 'epoch'))) AS delivered_at
         FROM unnest($2::uuid[]) AS o(user_id)
         LEFT JOIN conversation_reads r ON r.conversation_id = $1 AND r.user_id = o.user_id`,
      [conv.id, others],
    );
    return { deliveredAt: ms(rows[0]!.delivered_at) ?? 0, readAt: ms(rows[0]!.read_at) ?? 0 };
  }

  /**
   * "My phone has received this conversation" (the second tick). Only tells the others when something new was
   * really received, so two phones opening each other's chat can never nudge each other forever.
   */
  async function markDelivered(conv: ConvRow, userId: string, universityId: string) {
    const { rows } = await pool.query<{ newer: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM messages x WHERE x.conversation_id = $1 AND x.sender_id <> $2
                         AND x.created_at > COALESCE((SELECT last_delivered_at FROM conversation_reads WHERE conversation_id = $1 AND user_id = $2), 'epoch')) AS newer`,
      [conv.id, userId],
    );
    if (!rows[0]?.newer) {
      return;
    }
    await pool.query(
      `INSERT INTO conversation_reads (conversation_id, university_id, user_id, last_read_at, last_delivered_at) VALUES ($1, $2, $3, 'epoch', now())
       ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_delivered_at = now()`,
      [conv.id, universityId, userId],
    );
    hub.notify(await audience(conv, userId), { type: 'chat', conversationId: conv.id });
  }

  /** "I have read it" (the blue ticks). Same rule: the others hear about it only when something new was read. */
  async function markRead(conv: ConvRow, userId: string, universityId: string) {
    const { rows } = await pool.query<{ newer: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM messages x WHERE x.conversation_id = $1 AND x.sender_id <> $2
                         AND x.created_at > COALESCE((SELECT last_read_at FROM conversation_reads WHERE conversation_id = $1 AND user_id = $2), 'epoch')) AS newer`,
      [conv.id, userId],
    );
    await pool.query(
      `INSERT INTO conversation_reads (conversation_id, university_id, user_id, last_read_at, last_delivered_at) VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = now(), last_delivered_at = now()`,
      [conv.id, universityId, userId],
    );
    if (rows[0]?.newer) {
      hub.notify(await audience(conv, userId), { type: 'chat', conversationId: conv.id });
    }
  }

  // Newest 50, oldest first. `after` (ms) returns only messages newer than that, `before` older ones.
  app.get<{ Params: { id: string }; Querystring: { after?: string; before?: string } }>('/chats/:id/messages', member, async req => {
    const m = req.member!;
    const conv = await access(pool, uuid(req.params.id), m.universityId, m.userId);
    const q = parse(z.object({ after: z.coerce.number().int().min(0).optional(), before: z.coerce.number().int().min(0).optional() }), req.query);
    const { rows } = await pool.query<MessageRow>(
      `SELECT ${messageColumns('$4')} ${messageFrom}
        WHERE x.conversation_id = $1
          AND ($2::bigint IS NULL OR date_trunc('milliseconds', x.created_at) > to_timestamp($2::double precision / 1000))
          AND ($3::bigint IS NULL OR date_trunc('milliseconds', x.created_at) < to_timestamp($3::double precision / 1000))
          AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.blocker_id = $4 AND b.blocked_id = x.sender_id)
          AND ($5::timestamptz IS NULL OR x.created_at >= $5)
          AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = x.id AND h.user_id = $4)
        ORDER BY x.created_at DESC LIMIT 50`,
      [conv.id, q.after ?? null, q.before ?? null, m.userId, conv.kind === 'custom' ? conv.joined_at : null],
    );
    // Fetching the messages means this phone has received them: that is the second tick for the sender.
    await markDelivered(conv, m.userId, m.universityId);
    return { messages: rows.reverse().map(r => messageDto(r, m.userId)), receipts: await receiptsFor(conv, m.userId) };
  });

  interface Attachment {
    kind: 'image' | 'file';
    storageKey: string;
    thumbKey: string | null;
    name: string;
    mime: string;
    bytes: number;
    width: number | null;
    height: number | null;
  }

  /** Checks the rules, saves the message (with its attachment), and tells the other people. */
  async function deliver(req: FastifyRequest, conv: ConvRow, body: string, attachment: Attachment | null, replyTo: string | null = null) {
    const m = req.member!;
    if (replyTo) {
      const quoted = await pool.query('SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2', [replyTo, conv.id]);
      if (!quoted.rowCount) {
        throw badRequest('The message you are replying to is not in this chat.');
      }
    }
    const peer = conv.kind === 'dm' ? (conv.user_a === m.userId ? conv.user_b : conv.user_a) : null;
    if (conv.kind === 'custom' && conv.only_admins_post && conv.my_role !== 'admin') {
      throw forbidden('Only the group admins can send messages here.');
    }
    if (peer) {
      if (await blocked(pool, m.userId, peer)) {
        throw forbidden('You cannot message this person.');
      }
      const still = await pool.query("SELECT 1 FROM memberships WHERE user_id = $1 AND university_id = $2 AND status = 'active'", [peer, m.universityId]);
      if (!still.rowCount) {
        throw conflict('This person is no longer available.', 'peer_unavailable');
      }
    }
    const sentId = await withTx(pool, async c => {
      const { rows } = await c.query<{ id: string; created_at: Date }>(
        'INSERT INTO messages (conversation_id, university_id, sender_id, body, reply_to) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at',
        [conv.id, m.universityId, m.userId, body, replyTo],
      );
      const sent = rows[0] as { id: string; created_at: Date };
      if (attachment) {
        await c.query(
          `INSERT INTO message_attachments (message_id, university_id, kind, storage_key, thumb_key, name, mime, bytes, width, height)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [sent.id, m.universityId, attachment.kind, attachment.storageKey, attachment.thumbKey, attachment.name, attachment.mime, attachment.bytes, attachment.width, attachment.height],
        );
      }
      await c.query('UPDATE conversations SET last_message_at = $2 WHERE id = $1', [conv.id, sent.created_at]);
      await c.query(
        `INSERT INTO conversation_reads (conversation_id, university_id, user_id, last_read_at, last_delivered_at) VALUES ($1, $2, $3, now(), now())
         ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = now(), last_delivered_at = now()`,
        [conv.id, m.universityId, m.userId],
      );
      return sent.id;
    });
    // Tell everyone who is connected right now (no content in the nudge: the app fetches it the normal way).
    hub.notify(await audience(conv, m.userId), { type: 'chat', conversationId: conv.id });
    // A person-to-person message pings the other person, and so does a group the students made themselves
    // (everyone there chose to be in it). Society and study-group rooms stay quiet so they never turn into spam.
    const preview = body || (attachment?.kind === 'image' ? '📷 Photo' : `📄 ${attachment?.name ?? 'Document'}`);
    if (peer) {
      await push.sendToUsers([peer], { title: req.user!.name, body: preview.length > 80 ? `${preview.slice(0, 77)}...` : preview, data: { kind: 'chat' } });
    } else if (conv.kind === 'custom') {
      const text = `${req.user!.name}: ${preview}`;
      const reachable = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM conversation_members cm
          WHERE cm.conversation_id = $1 AND cm.user_id <> $2
            AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.blocker_id = cm.user_id AND b.blocked_id = $2)`,
        [conv.id, m.userId],
      );
      await push.sendToUsers(reachable.rows.map(r => r.user_id), { title: conv.name ?? 'Group', body: text.length > 100 ? `${text.slice(0, 97)}...` : text, data: { kind: 'chat' } });
    }
    return loadMessage(sentId, m.userId);
  }

  app.post<{ Params: { id: string } }>('/chats/:id/messages', { preHandler: guards.member, ...limit(40) }, async (req, reply) => {
    const m = req.member!;
    const conv = await access(pool, uuid(req.params.id), m.universityId, m.userId);
    const { body, replyTo } = parse(z.object({ body: z.string().trim().min(1).max(1000), replyTo: z.string().uuid().nullish() }), req.body);
    return reply.status(201).send(await deliver(req, conv, body, null, replyTo ?? null));
  });

  // A picture or a document (multipart: one file, and an optional text field "caption").
  // Pictures are decoded and re-saved (like every upload). Documents must really be a PDF or an Office file,
  // are never shown inline by a browser, and are always downloaded.
  app.post<{ Params: { id: string } }>('/chats/:id/attachments', { preHandler: guards.member, ...limit(20) }, async (req, reply) => {
    const m = req.member!;
    const conv = await access(pool, uuid(req.params.id), m.universityId, m.userId);
    const { fields, files } = await readMultipart(req, { maxFiles: 1, maxBytes: MAX_FILE_BYTES });
    const file = files[0];
    if (!file) {
      throw badRequest('Choose a picture or a document to send.');
    }
    const caption = (fields.caption ?? '').trim();
    if (caption.length > 1000) {
      throw badRequest('The caption can have up to 1000 characters.');
    }
    const today = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM message_attachments a JOIN messages x ON x.id = a.message_id WHERE x.sender_id = $1 AND a.created_at > now() - interval '1 day'", [m.userId]);
    if ((today.rows[0]?.n ?? 0) >= MAX_ATTACHMENTS_PER_DAY) {
      throw new AppError(429, 'upload_limit', `You can send up to ${MAX_ATTACHMENTS_PER_DAY} pictures and documents a day.`);
    }
    const id = randomUUID();
    const dir = `${m.universityId}/chat`;
    const written: string[] = [];
    let attachment: Attachment;
    try {
      const doc = detectDocument(file.data, file.name);
      if (doc) {
        const key = `${dir}/${id}.${doc.ext}`;
        await storage.put(key, file.data, doc.mime);
        written.push(key);
        attachment = { kind: 'file', storageKey: key, thumbKey: null, name: cleanName(file.name, doc.ext), mime: doc.mime, bytes: file.data.length, width: null, height: null };
      } else {
        if (file.data.length > MAX_UPLOAD_BYTES) {
          throw new AppError(413, 'file_too_large', `A picture can be up to ${Math.round(MAX_UPLOAD_BYTES / 1_048_576)} MB.`);
        }
        let image;
        try {
          image = await processImage(file.data);
        } catch {
          throw badRequest('You can send pictures (JPEG, PNG, WebP) and documents (PDF, Word, Excel, PowerPoint).');
        }
        written.push(`${dir}/${id}.jpg`, `${dir}/${id}_t.jpg`);
        await storage.put(`${dir}/${id}.jpg`, image.full, 'image/jpeg');
        await storage.put(`${dir}/${id}_t.jpg`, image.thumb, 'image/jpeg');
        attachment = { kind: 'image', storageKey: `${dir}/${id}.jpg`, thumbKey: `${dir}/${id}_t.jpg`, name: cleanName(file.name, 'jpg'), mime: 'image/jpeg', bytes: image.full.length, width: image.width, height: image.height };
      }
      const replyTo = /^[0-9a-f-]{36}$/i.test(fields.replyTo ?? '') ? (fields.replyTo as string) : null;
      const message = await deliver(req, conv, caption, attachment, replyTo);
      void emptyTrash(pool, storage).catch(() => undefined);
      return reply.status(201).send(message);
    } catch (err) {
      await Promise.all(written.map(k => storage.delete(k).catch(() => undefined))); // nothing half-saved is left behind
      throw err;
    }
  });

  // The file itself: the signed link is the proof (see media/signedUrl.ts). Pictures show; documents download.
  app.get<{ Params: { id: string; variant: string }; Querystring: { exp?: string; sig?: string } }>('/chat-files/:id/:variant', async (req, reply) => {
    const { id, variant } = req.params;
    if (!['full', 'thumb', 'file'].includes(variant) || !verifySignature(config, 'chat', id, variant, req.query.exp, req.query.sig)) {
      throw notFound();
    }
    const row = await pool.query<{ kind: string; storage_key: string; thumb_key: string | null; name: string; mime: string }>('SELECT kind, storage_key, thumb_key, name, mime FROM message_attachments WHERE id = $1', [uuid(id)]);
    const a = row.rows[0];
    const key = !a ? null : variant === 'thumb' ? a.thumb_key : a.storage_key;
    const file = key ? await storage.open(key) : null;
    if (!a || !file || (variant === 'file') !== (a.kind === 'file')) {
      throw notFound();
    }
    reply
      .header('Content-Type', a.mime)
      .header('Content-Length', file.size)
      .header('Cache-Control', 'private, max-age=86400')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cross-Origin-Resource-Policy', 'cross-origin');
    if (a.kind === 'file') {
      reply.header('Content-Disposition', `attachment; filename="${a.name.replace(/[^\w.\- ]/g, '_')}"`);
    }
    return reply.send(file.stream);
  });

  // ── reactions ──────────────────────────────────────────────────────────────
  /** A message of this conversation that I am allowed to see, or 404. */
  async function visibleMessage(conv: ConvRow, messageId: string, userId: string) {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM messages x WHERE x.id = $1 AND x.conversation_id = $2
          AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.blocker_id = $3 AND b.blocked_id = x.sender_id)
          AND ($4::timestamptz IS NULL OR x.created_at >= $4)`,
      [messageId, conv.id, userId, conv.kind === 'custom' ? conv.joined_at : null],
    );
    if (!rowCount) {
      throw notFound('Message not found.');
    }
  }

  app.put<{ Params: { id: string; messageId: string } }>('/chats/:id/messages/:messageId/reaction', { preHandler: guards.member, ...limit(120) }, async req => {
    const m = req.member!;
    const conv = await access(pool, uuid(req.params.id), m.universityId, m.userId);
    const messageId = uuid(req.params.messageId);
    const { emoji } = parse(z.object({ emoji: z.enum(REACTIONS) }), req.body);
    await visibleMessage(conv, messageId, m.userId);
    await pool.query(
      `INSERT INTO message_reactions (message_id, university_id, user_id, emoji) VALUES ($1, $2, $3, $4)
       ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji, created_at = now()`,
      [messageId, m.universityId, m.userId, emoji],
    );
    hub.notify(await audience(conv, m.userId), { type: 'chat', conversationId: conv.id });
    return loadMessage(messageId, m.userId);
  });

  app.delete<{ Params: { id: string; messageId: string } }>('/chats/:id/messages/:messageId/reaction', { preHandler: guards.member, ...limit(120) }, async req => {
    const m = req.member!;
    const conv = await access(pool, uuid(req.params.id), m.universityId, m.userId);
    const messageId = uuid(req.params.messageId);
    await visibleMessage(conv, messageId, m.userId);
    await pool.query('DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2', [messageId, m.userId]);
    hub.notify(await audience(conv, m.userId), { type: 'chat', conversationId: conv.id });
    return loadMessage(messageId, m.userId);
  });

  app.post<{ Params: { id: string } }>('/chats/:id/read', member, async (req, reply) => {
    const m = req.member!;
    const conv = await access(pool, uuid(req.params.id), m.universityId, m.userId);
    await markRead(conv, m.userId, m.universityId);
    return reply.status(204).send();
  });

  // Delete a message. "for me" hides it from my own view only; "for everyone" (only the sender, within two days)
  // leaves a "This message was deleted" in its place for everybody and removes its picture or document.
  app.delete<{ Params: { id: string; messageId: string }; Querystring: { for?: string } }>('/chats/:id/messages/:messageId', { preHandler: guards.member, ...limit(60) }, async (req, reply) => {
    const m = req.member!;
    const conv = await access(pool, uuid(req.params.id), m.universityId, m.userId);
    const messageId = uuid(req.params.messageId);
    const scope = parse(z.enum(['me', 'everyone']).default('me'), req.query.for);
    const { rows } = await pool.query<{ sender_id: string; kind: string; created_at: Date; deleted_at: Date | null }>(
      'SELECT sender_id, kind, created_at, deleted_at FROM messages WHERE id = $1 AND conversation_id = $2',
      [messageId, conv.id],
    );
    const msg = rows[0];
    if (!msg) {
      throw notFound('Message not found.');
    }
    if (scope === 'me') {
      await pool.query('INSERT INTO message_hidden (message_id, university_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [messageId, m.universityId, m.userId]);
      return reply.status(204).send();
    }
    if (msg.sender_id !== m.userId || msg.kind !== 'text') {
      throw forbidden('You can only delete your own messages for everyone.');
    }
    if (Date.now() - msg.created_at.getTime() > DELETE_FOR_EVERYONE_MS) {
      throw conflict('You can delete a message for everyone only within two days of sending it.', 'too_late');
    }
    await withTx(pool, async c => {
      await c.query("UPDATE messages SET deleted_at = COALESCE(deleted_at, now()), body = '' WHERE id = $1", [messageId]);
      await c.query('DELETE FROM message_attachments WHERE message_id = $1', [messageId]); // its files go to the trash list
      await c.query('DELETE FROM message_reactions WHERE message_id = $1', [messageId]);
    });
    await emptyTrash(pool, storage);
    hub.notify(await audience(conv, m.userId), { type: 'chat', conversationId: conv.id });
    return reply.status(204).send();
  });

  // Is this person online, and if not, when were they last seen? (Anyone in my university I have not blocked.)
  app.get<{ Params: { id: string } }>('/users/:id/presence', member, async req => {
    const m = req.member!;
    const target = uuid(req.params.id);
    const there = await pool.query("SELECT 1 FROM memberships WHERE user_id = $1 AND university_id = $2 AND status = 'active'", [target, m.universityId]);
    if (!there.rowCount || (await blocked(pool, m.userId, target))) {
      throw notFound('That student was not found.');
    }
    const online = hub.isOnline(target);
    const seen = online ? null : (await pool.query<{ last_seen_at: Date }>('SELECT last_seen_at FROM user_presence WHERE user_id = $1', [target])).rows[0];
    return { online, lastSeenAt: seen ? ms(seen.last_seen_at) : null };
  });

  // -- blocking ---------------------------------------------------------------
  app.get('/blocks', member, async req => {
    const m = req.member!;
    const { rows } = await pool.query<{ id: string; name: string }>('SELECT u.id, u.name FROM user_blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = $1 ORDER BY u.name', [m.userId]);
    return { blocked: rows.map(r => ({ uid: r.id, name: r.name })) };
  });

  app.put<{ Params: { id: string } }>('/users/:id/block', member, async (req, reply) => {
    const m = req.member!;
    const target = uuid(req.params.id);
    if (target === m.userId) {
      throw badRequest('You cannot block yourself.');
    }
    const there = await pool.query('SELECT 1 FROM memberships WHERE user_id = $1 AND university_id = $2', [target, m.universityId]);
    if (!there.rowCount) {
      throw notFound('That student was not found.');
    }
    await pool.query('INSERT INTO user_blocks (blocker_id, blocked_id, university_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [m.userId, target, m.universityId]);
    return reply.status(204).send();
  });

  app.delete<{ Params: { id: string } }>('/users/:id/block', member, async (req, reply) => {
    await pool.query('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [req.member!.userId, uuid(req.params.id)]);
    return reply.status(204).send();
  });
};
