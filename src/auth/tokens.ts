import { SignJWT, jwtVerify } from 'jose';
import type pg from 'pg';

import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { unauthorized } from '../lib/errors.js';
import { newRefreshToken, sha256 } from '../lib/secrets.js';

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
}

const encoder = new TextEncoder();
const ISSUER = 'campushub-api';

export async function signAccessToken(config: Config, userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${config.accessTtlSeconds}s`)
    .sign(encoder.encode(config.jwtSecret));
}

/** Returns the user id inside a valid access token, or throws 401. */
export async function verifyAccessToken(config: Config, token: string): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, encoder.encode(config.jwtSecret), { issuer: ISSUER, algorithms: ['HS256'] });
    if (!payload.sub) {
      throw new Error('no subject');
    }
    return payload.sub;
  } catch {
    throw unauthorized('Your session has expired. Please sign in again.');
  }
}

/** Creates a new session. The refresh token is stored only as a hash. */
export async function issueSession(config: Config, db: Db, userId: string): Promise<SessionTokens> {
  const refreshToken = newRefreshToken();
  await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [userId, sha256(refreshToken), config.refreshTtlDays],
  );
  return {
    accessToken: await signAccessToken(config, userId),
    refreshToken,
    expiresIn: config.accessTtlSeconds,
  };
}

/**
 * Exchanges a refresh token for a fresh pair. The old token is revoked in the same statement
 * that reads it, so a token can be used only once even if two requests race.
 */
export async function rotateSession(config: Config, pool: pg.Pool, refreshToken: string): Promise<{ userId: string; tokens: SessionTokens }> {
  const row = await pool.query<{ user_id: string }>(
    `UPDATE refresh_tokens SET revoked_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [sha256(refreshToken)],
  );
  const userId = row.rows[0]?.user_id;
  if (!userId) {
    throw unauthorized('Your session has expired. Please sign in again.');
  }
  return { userId, tokens: await issueSession(config, pool, userId) };
}

export async function revokeRefreshToken(db: Db, refreshToken: string): Promise<void> {
  await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(refreshToken)]);
}
