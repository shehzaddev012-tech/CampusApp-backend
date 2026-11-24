import { z } from 'zod';

import { verifyFirebaseIdToken } from '../auth/firebase.js';
import { issueSession, revokeRefreshToken, rotateSession } from '../auth/tokens.js';
import type { Db } from '../db/pool.js';
import { notFound } from '../lib/errors.js';
import { ms, parse } from '../lib/http.js';
import { getUniversity } from './universities.js';
import type { Routes } from './types.js';

interface UserRow {
  id: string;
  email: string;
  name: string;
  photo_url: string | null;
}

/**
 * Finds or creates the person for an email. A name is only written when the sign-in actually
 * supplied one, so signing in again without a name never overwrites the one already stored.
 */
export async function upsertUser(db: Db, who: { email: string; name: string | null; photoUrl: string | null }): Promise<UserRow> {
  const email = who.email.trim();
  const name = who.name?.trim() || null;
  const { rows } = await db.query<UserRow>(
    `INSERT INTO users (email, name, photo_url) VALUES ($1, COALESCE($2::text, split_part($1, '@', 1)), $3)
     ON CONFLICT ((lower(email))) DO UPDATE
       SET name = COALESCE($2::text, users.name), photo_url = CASE WHEN users.photo_version > 0 THEN users.photo_url ELSE COALESCE(EXCLUDED.photo_url, users.photo_url) END
     RETURNING id, email, name, photo_url`,
    [email, name, who.photoUrl],
  );
  return rows[0] as UserRow;
}

export function userDto(u: UserRow) {
  return { uid: u.id, name: u.name, email: u.email, photoUrl: u.photo_url };
}

const authLimit = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

export const authRoutes: Routes = async (app, { deps, guards }) => {
  const { config, pool } = deps;

  app.post('/auth/google', authLimit, async req => {
    // Real Google sign-in works whenever the Firebase service account is set up, also next to the dev test accounts.
    if (config.authMode !== 'firebase' && !config.firebaseServiceAccount) {
      throw notFound();
    }
    const { idToken } = parse(z.object({ idToken: z.string().min(20) }), req.body);
    const user = await upsertUser(pool, await verifyFirebaseIdToken(config, idToken));
    // Google already verified this email address.
    await pool.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1', [user.id]);
    return { user: userDto(user), ...(await issueSession(config, pool, user.id)) };
  });

  // Development and testing only. Never reachable in production (see config.ts).
  app.post('/auth/dev', authLimit, async req => {
    if (config.authMode !== 'dev') {
      throw notFound();
    }
    const body = parse(z.object({ email: z.email(), name: z.string().min(1).max(80).optional() }), req.body);
    const user = await upsertUser(pool, { email: body.email, name: body.name ?? null, photoUrl: null });
    return { user: userDto(user), ...(await issueSession(config, pool, user.id)) };
  });

  // Lists the seeded test accounts so a developer can pick one on the sign-in screen.
  app.get('/dev/accounts', async () => {
    if (config.authMode !== 'dev') {
      throw notFound();
    }
    const { rows } = await pool.query<{ email: string; name: string; role: string; university_id: string; department: string }>(
      `SELECT u.email, u.name, m.role, m.university_id, m.department
         FROM users u JOIN memberships m ON m.user_id = u.id
        WHERE u.email LIKE '%.test' AND m.status = 'active'
        ORDER BY m.university_id, m.role, u.email`,
    );
    return { accounts: rows.map(r => ({ email: r.email, name: r.name, role: r.role, universityId: r.university_id, department: r.department })) };
  });

  app.post('/auth/refresh', authLimit, async req => {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().min(20) }), req.body);
    const { tokens } = await rotateSession(config, pool, refreshToken);
    return tokens;
  });

  app.post('/auth/logout', async (req, reply) => {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().min(20) }), req.body);
    await revokeRefreshToken(pool, refreshToken);
    return reply.status(204).send();
  });

  // Who am I, which university am I in, and has it approved me?
  app.get('/me', { preHandler: guards.user }, async req => {
    const user = req.user!;
    const member = req.member ?? null;
    const university = member ? await getUniversity(pool, member.universityId) : null;
    const created = member
      ? (await pool.query<{ created_at: Date }>('SELECT created_at FROM memberships WHERE user_id = $1', [user.id])).rows[0]?.created_at
      : null;
    return {
      user: { uid: user.id, name: user.name, email: user.email, photoUrl: user.photoUrl },
      membership: member
        ? {
            uid: user.id,
            universityId: member.universityId,
            name: user.name,
            email: user.email,
            photoUrl: user.photoUrl,
            studentId: member.studentId,
            department: member.department,
            batch: member.batch,
            role: member.role,
            status: member.status,
            createdAt: ms(created ?? null),
          }
        : null,
      university,
    };
  });
};
