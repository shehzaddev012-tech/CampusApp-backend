import { createHmac, randomInt } from 'node:crypto';

import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { AppError, badRequest } from '../lib/errors.js';
import { safeEqual } from '../lib/secrets.js';
import { OTP_MINUTES, type OtpPurpose } from '../mail/templates.js';

export const OTP_MAX_ATTEMPTS = 5;
export const OTP_COOLDOWN_SECONDS = 60;

const hashCode = (config: Config, email: string, purpose: OtpPurpose, code: string) =>
  createHmac('sha256', config.jwtSecret).update(`${email}|${purpose}|${code}`).digest('hex');

export interface IssuedOtp {
  code: string;
  payload: Record<string, unknown>;
}

/**
 * Creates (or replaces) the one unused code for this email and purpose.
 * Asking again within the cooldown is refused, so nobody can use us to flood an inbox.
 */
export async function issueOtp(
  db: Db,
  config: Config,
  email: string,
  purpose: OtpPurpose,
  payload: Record<string, unknown> = {},
): Promise<IssuedOtp> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO email_otps (email, purpose, code_hash, payload, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, now() + make_interval(mins => $5))
     ON CONFLICT (email, purpose) WHERE used_at IS NULL DO UPDATE
       SET code_hash = EXCLUDED.code_hash, payload = EXCLUDED.payload, attempts = 0,
           expires_at = EXCLUDED.expires_at, created_at = now()
       WHERE email_otps.created_at <= now() - make_interval(secs => $6)
     RETURNING id`,
    [email, purpose, hashCode(config, email, purpose, code), JSON.stringify(payload), OTP_MINUTES, OTP_COOLDOWN_SECONDS],
  );
  if (rows.length === 0) {
    const wait = await db.query<{ left: number }>(
      `SELECT GREATEST(1, ceil(extract(epoch FROM (created_at + make_interval(secs => $3) - now()))))::int AS left
         FROM email_otps WHERE email = $1 AND purpose = $2 AND used_at IS NULL`,
      [email, purpose, OTP_COOLDOWN_SECONDS],
    );
    const left = wait.rows[0]?.left ?? OTP_COOLDOWN_SECONDS;
    throw new AppError(429, 'otp_cooldown', `Please wait ${left} seconds before asking for another code.`, { retryAfterSeconds: left });
  }
  // Housekeeping: old rows are of no use to anyone.
  await db.query(`DELETE FROM email_otps WHERE created_at < now() - interval '1 day'`);
  return { code, payload };
}

/** The payload stored with the current unused code (used to resend without asking for everything again). */
export async function currentOtpPayload(db: Db, email: string, purpose: OtpPurpose): Promise<Record<string, unknown> | null> {
  const { rows } = await db.query<{ payload: Record<string, unknown> }>(
    'SELECT payload FROM email_otps WHERE email = $1 AND purpose = $2 AND used_at IS NULL',
    [email, purpose],
  );
  return rows[0]?.payload ?? null;
}

/**
 * Checks a code. Every check first spends one of the limited tries in a single atomic statement,
 * so parallel guesses cannot beat the limit. A correct code is marked used at once (one use only).
 */
export async function checkOtp(db: Db, config: Config, email: string, purpose: OtpPurpose, code: string): Promise<Record<string, unknown>> {
  const tried = await db.query<{ id: string; code_hash: string; payload: Record<string, unknown>; attempts: number }>(
    `UPDATE email_otps SET attempts = attempts + 1
      WHERE email = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now() AND attempts < $3
      RETURNING id, code_hash, payload, attempts`,
    [email, purpose, OTP_MAX_ATTEMPTS],
  );
  const row = tried.rows[0];
  if (!row) {
    const locked = await db.query('SELECT 1 FROM email_otps WHERE email = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()', [email, purpose]);
    if (locked.rowCount) {
      throw new AppError(400, 'otp_locked', 'Too many wrong codes. Please ask for a new code.');
    }
    throw new AppError(400, 'otp_expired', 'This code has expired or was already used. Please ask for a new one.');
  }
  if (!safeEqual(hashCode(config, email, purpose, code), row.code_hash)) {
    const left = OTP_MAX_ATTEMPTS - row.attempts;
    throw new AppError(400, 'otp_invalid', left > 0 ? `That code is not correct. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong codes. Please ask for a new code.');
  }
  const used = await db.query('UPDATE email_otps SET used_at = now() WHERE id = $1 AND used_at IS NULL', [row.id]);
  if (!used.rowCount) {
    throw badRequest('This code was already used.');
  }
  return row.payload;
}
