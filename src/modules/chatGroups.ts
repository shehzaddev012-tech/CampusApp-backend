import { z } from 'zod';

import { withTx, type Db } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { postSystemMessage } from '../chat/system.js';
import { ms, parse, uuid } from '../lib/http.js';
import { emptyTrash } from '../media/trash.js';
import type { Routes } from './types.js';

const MAX_MEMBERS = 100;

const name = z.string().trim().min(2).max(60);
const about = z.string().trim().max(300);

interface GroupRow {
  id: string;
  name: string;
  about: string;
  only_admins_post: boolean;
  created_at: Date;
  my_role: 'member' | 'admin';
}

/**
 * Groups students make themselves (like a WhatsApp group): a name, members, and admins who can add or remove people.
 * Every member belongs to the same university (enforced by the composite key to `memberships`), people who block each
 * other cannot be put in a group by one another, and a new member sees only what is said after they join.
 */
export const chatGroupsRoutes: Routes = async (app, { deps, guards }) => {
  const { pool, hub, storage } = deps;
  const member = { preHandler: guards.member };

  /** The group, if I am in it. Otherwise "not found" (never reveals that it exists). */
  async function mine(db: Db, id: string, universityId: string, userId: string): Promise<GroupRow> {
    const { rows } = await db.query<GroupRow>(
      `SELECT c.id, c.name, c.about, c.only_admins_post, c.created_at, cm.role AS my_role
         FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $3
        WHERE c.id = $1 AND c.university_id = $2 AND c.kind = 'custom'`,
      [id, universityId, userId],
    );
    if (!rows[0]) {
      throw notFound('Group not found.');
    }
    return rows[0];
  }
  const mustAdmin = (g: GroupRow) => {
    if (g.my_role !== 'admin') {
      throw forbidden('Only group admins can do this.');
    }
  };
  const memberIds = async (db: Db, id: string) => (await db.query<{ user_id: string }>('SELECT user_id FROM conversation_members WHERE conversation_id = $1', [id])).rows.map(r => r.user_id);
  const tell = (ids: string[], conversationId: string) => hub.notify(ids, { type: 'chat', conversationId });
  /** "Bilal Ahmed, Cara Khan" for a system message, in the order the people were given. */
  const namesOf = async (db: Db, ids: string[]) => {
    const { rows } = await db.query<{ id: string; name: string }>('SELECT id, name FROM users WHERE id = ANY($1::uuid[])', [ids]);
    const by = new Map(rows.map(r => [r.id, r.name]));
    return ids.map(i => by.get(i) ?? 'someone').join(', ');
  };

  /** Active members of this university that `by` may put in a group (nobody blocking, or blocked by, `by`). */
  async function addable(db: Db, universityId: string, by: string, ids: string[]): Promise<string[]> {
    if (ids.length === 0) {
      return [];
    }
    const { rows } = await db.query<{ user_id: string }>(
      `SELECT mem.user_id FROM memberships mem
        WHERE mem.university_id = $1 AND mem.status = 'active' AND mem.user_id = ANY($3::uuid[])
          AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $2 AND b.blocked_id = mem.user_id) OR (b.blocker_id = mem.user_id AND b.blocked_id = $2))`,
      [universityId, by, ids],
    );
    return rows.map(r => r.user_id);
  }

  const info = async (g: GroupRow, viewerId: string) => {
    const { rows } = await pool.query<{ id: string; name: string; photo_url: string | null; role: string; joined_at: Date }>(
      `SELECT u.id, u.name, u.photo_url, cm.role, cm.joined_at FROM conversation_members cm JOIN users u ON u.id = cm.user_id
        WHERE cm.conversation_id = $1 ORDER BY (cm.role = 'admin') DESC, cm.joined_at, u.name`,
      [g.id],
    );
    return {
      id: g.id,
      name: g.name,
      about: g.about,
      onlyAdminsPost: g.only_admins_post,
      createdAt: ms(g.created_at),
      myRole: g.my_role,
      members: rows.map(r => ({ uid: r.id, name: r.name, photoUrl: r.photo_url, role: r.role, joinedAt: ms(r.joined_at), isMe: r.id === viewerId })),
    };
  };

  app.post('/chats/groups', member, async (req, reply) => {
    const m = req.member!;
    const b = parse(z.object({ name, about: about.default(''), memberIds: z.array(z.string().uuid()).max(MAX_MEMBERS - 1).default([]) }), req.body);
    const wanted = [...new Set(b.memberIds.filter(id => id !== m.userId))];
    const ok = await addable(pool, m.universityId, m.userId, wanted);
    if (ok.length !== wanted.length) {
      throw badRequest('Some of the people you chose cannot be added. They may have left, or one of you blocked the other.');
    }
    const id = await withTx(pool, async c => {
      const conv = await c.query<{ id: string }>(
        "INSERT INTO conversations (university_id, kind, name, about, created_by) VALUES ($1, 'custom', $2, $3, $4) RETURNING id",
        [m.universityId, b.name, b.about, m.userId],
      );
      const cid = (conv.rows[0] as { id: string }).id;
      // clock_timestamp() (not the transaction's now()) so that "who joined first" is always clear.
      await c.query("INSERT INTO conversation_members (conversation_id, university_id, user_id, role, added_by, joined_at) VALUES ($1, $2, $3, 'admin', $3, clock_timestamp())", [cid, m.universityId, m.userId]);
      for (const u of wanted) {
        await c.query('INSERT INTO conversation_members (conversation_id, university_id, user_id, added_by, joined_at) VALUES ($1, $2, $3, $4, clock_timestamp())', [cid, m.universityId, u, m.userId]);
      }
      await postSystemMessage(c, cid, m.universityId, m.userId, 'created this group');
      if (wanted.length > 0) {
        await postSystemMessage(c, cid, m.universityId, m.userId, `added ${await namesOf(c, wanted)}`);
      }
      return cid;
    });
    tell(ok, id);
    return reply.status(201).send({ id, title: b.name });
  });

  app.get<{ Params: { id: string } }>('/chats/groups/:id', member, async req => {
    const m = req.member!;
    return info(await mine(pool, uuid(req.params.id), m.universityId, m.userId), m.userId);
  });

  app.patch<{ Params: { id: string } }>('/chats/groups/:id', member, async req => {
    const m = req.member!;
    const g = await mine(pool, uuid(req.params.id), m.universityId, m.userId);
    mustAdmin(g);
    const b = parse(z.object({ name: name.optional(), about: about.optional(), onlyAdminsPost: z.boolean().optional() }), req.body);
    await pool.query(
      'UPDATE conversations SET name = COALESCE($2, name), about = COALESCE($3, about), only_admins_post = COALESCE($4, only_admins_post) WHERE id = $1',
      [g.id, b.name ?? null, b.about ?? null, b.onlyAdminsPost ?? null],
    );
    if (b.name !== undefined && b.name !== g.name) {
      await postSystemMessage(pool, g.id, m.universityId, m.userId, `changed the group name to "${b.name}"`);
    }
    tell(await memberIds(pool, g.id), g.id);
    return info(await mine(pool, g.id, m.universityId, m.userId), m.userId);
  });

  // Admins add people (a new person sees only what is said from now on).
  app.post<{ Params: { id: string } }>('/chats/groups/:id/members', member, async (req, reply) => {
    const m = req.member!;
    const g = await mine(pool, uuid(req.params.id), m.universityId, m.userId);
    mustAdmin(g);
    const { userIds } = parse(z.object({ userIds: z.array(z.string().uuid()).min(1).max(MAX_MEMBERS) }), req.body);
    const have = new Set(await memberIds(pool, g.id));
    const fresh = [...new Set(userIds)].filter(id => !have.has(id));
    if (have.size + fresh.length > MAX_MEMBERS) {
      throw conflict(`A group can have up to ${MAX_MEMBERS} people.`, 'group_full');
    }
    const ok = await addable(pool, m.universityId, m.userId, fresh);
    if (ok.length !== fresh.length) {
      throw badRequest('Some of the people you chose cannot be added. They may have left, or one of you blocked the other.');
    }
    for (const u of fresh) {
      await pool.query('INSERT INTO conversation_members (conversation_id, university_id, user_id, added_by, joined_at) VALUES ($1, $2, $3, $4, clock_timestamp()) ON CONFLICT DO NOTHING', [g.id, m.universityId, u, m.userId]);
    }
    if (fresh.length > 0) {
      await postSystemMessage(pool, g.id, m.universityId, m.userId, `added ${await namesOf(pool, fresh)}`);
    }
    tell([...have, ...ok], g.id);
    return reply.status(200).send(await info(g, m.userId));
  });

  // An admin removes someone else. (To go yourself, use "leave".)
  app.delete<{ Params: { id: string; userId: string } }>('/chats/groups/:id/members/:userId', member, async (req, reply) => {
    const m = req.member!;
    const g = await mine(pool, uuid(req.params.id), m.universityId, m.userId);
    mustAdmin(g);
    const target = uuid(req.params.userId);
    if (target === m.userId) {
      throw badRequest('Use "Leave group" to leave.');
    }
    const gone = await pool.query('DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [g.id, target]);
    if (!gone.rowCount) {
      throw notFound('That person is not in this group.');
    }
    await postSystemMessage(pool, g.id, m.universityId, m.userId, `removed ${await namesOf(pool, [target])}`);
    tell([...(await memberIds(pool, g.id)), target], g.id);
    return reply.status(204).send();
  });

  // Anyone can leave. If no admin is left, the person who has been in the group longest becomes one.
  app.post<{ Params: { id: string } }>('/chats/groups/:id/leave', member, async (req, reply) => {
    const m = req.member!;
    const g = await mine(pool, uuid(req.params.id), m.universityId, m.userId);
    const rest = await withTx(pool, async c => {
      await c.query('DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [g.id, m.userId]);
      const left = await memberIds(c, g.id);
      if (left.length === 0) {
        await c.query('DELETE FROM conversations WHERE id = $1', [g.id]); // nobody left: the group and its messages go
        return left;
      }
      await postSystemMessage(c, g.id, m.universityId, m.userId, 'left');
      const admins = await c.query('SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND role = $2', [g.id, 'admin']);
      if (!admins.rowCount) {
        await c.query(
          `UPDATE conversation_members SET role = 'admin'
            WHERE conversation_id = $1 AND user_id = (SELECT user_id FROM conversation_members WHERE conversation_id = $1 ORDER BY joined_at LIMIT 1)`,
          [g.id],
        );
      }
      return left;
    });
    if (rest.length === 0) {
      await emptyTrash(pool, storage); // the group is gone, and so are its pictures and documents
    }
    tell([...rest, m.userId], g.id);
    return reply.status(204).send();
  });

  app.put<{ Params: { id: string; userId: string } }>('/chats/groups/:id/admins/:userId', member, async (req, reply) => {
    const m = req.member!;
    const g = await mine(pool, uuid(req.params.id), m.universityId, m.userId);
    mustAdmin(g);
    const done = await pool.query("UPDATE conversation_members SET role = 'admin' WHERE conversation_id = $1 AND user_id = $2", [g.id, uuid(req.params.userId)]);
    if (!done.rowCount) {
      throw notFound('That person is not in this group.');
    }
    tell(await memberIds(pool, g.id), g.id);
    return reply.status(200).send({ ok: true });
  });

  app.delete<{ Params: { id: string; userId: string } }>('/chats/groups/:id/admins/:userId', member, async (req, reply) => {
    const m = req.member!;
    const g = await mine(pool, uuid(req.params.id), m.universityId, m.userId);
    mustAdmin(g);
    const target = uuid(req.params.userId);
    await withTx(pool, async c => {
      await c.query('SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE', [g.id]); // two admins demoting each other at once
      const admins = await c.query<{ user_id: string }>("SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND role = 'admin'", [g.id]);
      if (admins.rows.length <= 1 && admins.rows[0]?.user_id === target) {
        throw conflict('A group needs at least one admin. Make someone else an admin first.', 'last_admin');
      }
      await c.query("UPDATE conversation_members SET role = 'member' WHERE conversation_id = $1 AND user_id = $2", [g.id, target]);
    });
    tell(await memberIds(pool, g.id), g.id);
    return reply.status(200).send({ ok: true });
  });

  // An admin deletes the whole group, with its messages, for everyone.
  app.delete<{ Params: { id: string } }>('/chats/groups/:id', member, async (req, reply) => {
    const m = req.member!;
    const g = await mine(pool, uuid(req.params.id), m.universityId, m.userId);
    mustAdmin(g);
    const everyone = await memberIds(pool, g.id);
    await pool.query('DELETE FROM conversations WHERE id = $1', [g.id]);
    await emptyTrash(pool, storage); // its pictures and documents go too
    tell(everyone, g.id);
    return reply.status(204).send();
  });
};
