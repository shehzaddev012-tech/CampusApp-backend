import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';

import { OTP_COOLDOWN_SECONDS, checkOtp, currentOtpPayload, issueOtp } from '../auth/otp.js';
import { PASSWORD_MAX, burnPasswordCheck, hashPassword, passwordProblem, verifyPassword } from '../auth/password.js';
import { issueSession } from '../auth/tokens.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { parse } from '../lib/http.js';
import type { Mail } from '../mail/mailer.js';
import { alreadyRegisteredEmail, otpEmail, passwordChangedEmail, type OtpPurpose } from '../mail/templates.js';
import { userDto } from './auth.js';
import type { Routes } from './types.js';

const MAX_FAILED_LOGINS = 8;
const LOCK_MINUTES = 15;

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const code = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.');
const password = z.string().min(1).max(PASSWORD_MAX + 64);

interface DbUser {
  id: string;
  email: string;
  name: string;
  photo_url: string | null;
  password_hash: string | null;
  failed_logins: number;
  locked_until: Date | null;
}

export const passwordAuthRoutes: Routes = async (app, { deps }) => {
  const { config, pool, mailer } = deps;

  // Sign-in routes are rate limited per IP. Tests are not limited (they make many calls).
  const limit = (max: number) => ({ config: { rateLimit: { max: config.nodeEnv === 'test' ? 100_000 : max, timeWindow: '1 minute' } } });

  /** Sends an email. If it cannot be sent, the code made for it is dropped, so the person can try again at once. */
  async function send(mail: Mail, log: FastifyBaseLogger, undo?: { email: string; purpose: OtpPurpose }): Promise<void> {
    try {
      await mailer.send(mail);
    } catch (err) {
      log.error({ err }, 'Could not send email');
      if (undo) {
        await pool.query('DELETE FROM email_otps WHERE email = $1 AND purpose = $2 AND used_at IS NULL', [undo.email, undo.purpose]);
      }
      throw new AppError(502, 'email_failed', 'We could not send the email right now. Please try again in a moment.');
    }
  }

  const findUser = async (addr: string): Promise<DbUser | null> =>
    (
      await pool.query<DbUser>(
        'SELECT id, email, name, photo_url, password_hash, failed_logins, locked_until FROM users WHERE lower(email) = $1',
        [addr],
      )
    ).rows[0] ?? null;

  const sessionFor = async (userId: string) => {
    const user = (await pool.query<DbUser>('SELECT id, email, name, photo_url, password_hash, failed_logins, locked_until FROM users WHERE id = $1', [userId])).rows[0];
    if (!user) {
      throw notFound();
    }
    return { status: 'ok' as const, user: userDto(user), ...(await issueSession(config, pool, user.id)) };
  };

  const sent = (addr: string) => ({ ok: true, email: addr, resendAfterSeconds: OTP_COOLDOWN_SECONDS });

  /** Step 1 of sign-up. Nothing is created until the emailed code is confirmed. */
  app.post('/auth/register', limit(6), async (req, reply) => {
    const body = parse(z.object({ name: z.string().trim().min(2, 'Enter your name.').max(80), email, password }), req.body);
    const problem = passwordProblem(body.password, body.email);
    if (problem) {
      throw new AppError(400, 'weak_password', problem);
    }
    // Always hash, so "new email" and "already registered" take the same time.
    const hash = await hashPassword(body.password);
    const existing = await findUser(body.email);
    if (existing?.password_hash) {
      // Do not reveal that the account exists: the person who owns it is told by email instead.
      await issueOtp(pool, config, body.email, 'signup', { existing: true });
      await send(alreadyRegisteredEmail(body.email, existing.name), req.log, { email: body.email, purpose: 'signup' });
    } else {
      const issued = await issueOtp(pool, config, body.email, 'signup', { name: body.name, passwordHash: hash });
      await send(otpEmail('signup', body.email, body.name, issued.code), req.log, { email: body.email, purpose: 'signup' });
    }
    return reply.status(200).send(sent(body.email));
  });

  /** Step 2 of sign-up: the code proves the email is theirs, then the account is created and signed in. */
  app.post('/auth/verify-email', limit(10), async req => {
    const body = parse(z.object({ email, code }), req.body);
    const payload = await checkOtp(pool, config, body.email, 'signup', body.code);
    if (payload.existing || typeof payload.passwordHash !== 'string' || typeof payload.name !== 'string') {
      throw new AppError(400, 'otp_expired', 'This code has expired or was already used. Please ask for a new one.');
    }
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, email_verified_at) VALUES ($1, $2, $3, now())
       ON CONFLICT ((lower(email))) DO UPDATE
         SET password_hash = COALESCE(users.password_hash, EXCLUDED.password_hash),
             email_verified_at = COALESCE(users.email_verified_at, now())
       RETURNING id`,
      [body.email, payload.name, payload.passwordHash],
    );
    return sessionFor((rows[0] as { id: string }).id);
  });

  /** Password check. With two-step sign-in on, a code is emailed and /auth/login/verify finishes it. */
  app.post('/auth/login', limit(10), async req => {
    const body = parse(z.object({ email, password }), req.body);
    const user = await findUser(body.email);
    const wrong = new AppError(401, 'invalid_credentials', 'Email or password is incorrect. If you signed up with Google, use Continue with Google.');

    if (user?.locked_until && user.locked_until.getTime() > Date.now()) {
      const mins = Math.max(1, Math.ceil((user.locked_until.getTime() - Date.now()) / 60_000));
      throw new AppError(429, 'account_locked', `Too many wrong passwords. Try again in ${mins} minute${mins === 1 ? '' : 's'}, or reset your password.`);
    }
    if (!user?.password_hash) {
      await burnPasswordCheck(body.password);
      throw wrong;
    }
    if (!(await verifyPassword(body.password, user.password_hash))) {
      await pool.query(
        `UPDATE users SET failed_logins = failed_logins + 1,
                locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
          WHERE id = $1`,
        [user.id, MAX_FAILED_LOGINS, LOCK_MINUTES],
      );
      throw wrong;
    }
    await pool.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [user.id]);

    if (!config.requireLoginOtp) {
      return sessionFor(user.id);
    }
    try {
      const issued = await issueOtp(pool, config, body.email, 'login');
      await send(otpEmail('login', body.email, user.name, issued.code), req.log, { email: body.email, purpose: 'login' });
    } catch (err) {
      // A code was sent a moment ago and is still valid: do not send another one.
      if (!(err instanceof AppError && err.code === 'otp_cooldown')) {
        throw err;
      }
    }
    return { status: 'otp_required' as const, email: body.email, resendAfterSeconds: OTP_COOLDOWN_SECONDS };
  });

  app.post('/auth/login/verify', limit(10), async req => {
    const body = parse(z.object({ email, code }), req.body);
    await checkOtp(pool, config, body.email, 'login', body.code);
    const user = await findUser(body.email);
    if (!user) {
      throw new AppError(400, 'otp_expired', 'This code has expired or was already used. Please ask for a new one.');
    }
    return sessionFor(user.id);
  });

  /** "Send the code again" for sign-up, sign-in and password reset. */
  app.post('/auth/otp/resend', limit(6), async (req, reply) => {
    const body = parse(z.object({ email, purpose: z.enum(['signup', 'login', 'reset']) }), req.body);
    const purpose: OtpPurpose = body.purpose;
    const payload = await currentOtpPayload(pool, body.email, purpose);
    if (!payload) {
      throw new AppError(400, 'otp_expired', 'Please start again.');
    }
    const issued = await issueOtp(pool, config, body.email, purpose, payload);
    if (purpose === 'signup') {
      if (payload.existing) {
        const user = await findUser(body.email);
        await send(alreadyRegisteredEmail(body.email, user?.name ?? 'there'), req.log, { email: body.email, purpose });
      } else {
        await send(otpEmail('signup', body.email, String(payload.name ?? 'there'), issued.code), req.log, { email: body.email, purpose });
      }
    } else if (!payload.none) {
      const user = await findUser(body.email);
      if (user) {
        await send(otpEmail(purpose, body.email, user.name, issued.code), req.log, { email: body.email, purpose });
      }
    }
    return reply.status(200).send(sent(body.email));
  });

  /** Always answers the same, whether or not the email has an account. */
  app.post('/auth/forgot', limit(6), async (req, reply) => {
    const body = parse(z.object({ email }), req.body);
    const user = await findUser(body.email);
    try {
      const issued = await issueOtp(pool, config, body.email, 'reset', user ? {} : { none: true });
      if (user) {
        await send(otpEmail('reset', body.email, user.name, issued.code), req.log, { email: body.email, purpose: 'reset' });
      }
    } catch (err) {
      if (!(err instanceof AppError && err.code === 'otp_cooldown')) {
        throw err;
      }
    }
    return reply.status(200).send(sent(body.email));
  });

  app.post('/auth/reset', limit(10), async (req, reply) => {
    const body = parse(z.object({ email, code, newPassword: password }), req.body);
    const problem = passwordProblem(body.newPassword, body.email);
    if (problem) {
      throw new AppError(400, 'weak_password', problem); // checked first, so a typo does not use up a try
    }
    const payload = await checkOtp(pool, config, body.email, 'reset', body.code);
    if (payload.none) {
      throw new AppError(400, 'otp_expired', 'This code has expired or was already used. Please ask for a new one.');
    }
    const hash = await hashPassword(body.newPassword);
    const { rows } = await pool.query<{ id: string; name: string }>(
      `UPDATE users SET password_hash = $2, email_verified_at = COALESCE(email_verified_at, now()),
                        failed_logins = 0, locked_until = NULL
        WHERE lower(email) = $1 RETURNING id, name`,
      [body.email, hash],
    );
    const user = rows[0];
    if (!user) {
      throw badRequest('Please start again.');
    }
    // A new password signs the account out everywhere.
    await pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [user.id]);
    send(passwordChangedEmail(body.email, user.name), req.log).catch(() => undefined);
    return reply.status(200).send({ ok: true });
  });

  // Development only: read the emails the server "sent" when no SMTP server is configured.
  app.get('/dev/outbox', async req => {
    const outbox = mailer.outbox;
    if (!outbox || config.nodeEnv === 'production') {
      throw notFound();
    }
    const to = typeof (req.query as { to?: unknown }).to === 'string' ? (req.query as { to: string }).to : undefined;
    const list = to ? outbox.to(to) : outbox.sent;
    return { emails: list.slice(-10).reverse().map(m => ({ to: m.to, subject: m.subject, code: m.code ?? null })) };
  });
};

