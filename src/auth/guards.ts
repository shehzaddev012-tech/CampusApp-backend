import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Deps } from '../app.js';
import type { MemberStatus, Role } from '../domain.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { verifyAccessToken } from './tokens.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  photoUrl: string | null;
}

export interface Member {
  userId: string;
  universityId: string;
  studentId: string;
  department: string;
  batch: string;
  role: Role;
  status: MemberStatus;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
    /** null when the signed-in user has not joined a university. */
    member?: Member | null;
  }
}

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface Guards {
  /** Must be signed in. Loads req.user and req.member. */
  user: Guard;
  /** Must be signed in AND an approved member of a university. */
  member: Guard;
  /** Must be an approved member with one of these roles. */
  roles: (...roles: readonly Role[]) => Guard;
}

interface Row {
  id: string;
  email: string;
  name: string;
  photo_url: string | null;
  university_id: string | null;
  student_id: string | null;
  department: string | null;
  batch: string | null;
  role: Role | null;
  status: MemberStatus | null;
}

export function createGuards({ config, pool }: Deps): Guards {
  const user: Guard = async req => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw unauthorized('Please sign in.');
    }
    const userId = await verifyAccessToken(config, header.slice(7));
    const { rows } = await pool.query<Row>(
      `SELECT u.id, u.email, u.name, u.photo_url,
              m.university_id, m.student_id, m.department, m.batch, m.role, m.status
         FROM users u LEFT JOIN memberships m ON m.user_id = u.id
        WHERE u.id = $1`,
      [userId],
    );
    const r = rows[0];
    if (!r) {
      throw unauthorized('This account no longer exists.');
    }
    req.user = { id: r.id, email: r.email, name: r.name, photoUrl: r.photo_url };
    req.member =
      r.university_id && r.student_id && r.department !== null && r.batch !== null && r.role && r.status
        ? { userId: r.id, universityId: r.university_id, studentId: r.student_id, department: r.department, batch: r.batch, role: r.role, status: r.status }
        : null;
  };

  const member: Guard = async (req, reply) => {
    await user(req, reply);
    if (!req.member) {
      throw forbidden('Join a university first.');
    }
    if (req.member.status !== 'active') {
      throw forbidden(req.member.status === 'pending' ? 'Your join request is still waiting for approval.' : 'Your membership is not active.');
    }
  };

  const roles =
    (...allowed: readonly Role[]): Guard =>
    async (req, reply) => {
      await member(req, reply);
      if (!req.member || !allowed.includes(req.member.role)) {
        throw forbidden();
      }
    };

  return { user, member, roles };
}
