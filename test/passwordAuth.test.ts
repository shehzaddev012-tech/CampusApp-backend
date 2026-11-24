import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { OTP_MAX_ATTEMPTS } from '../src/auth/otp.js';
import { createCtx, type Ctx } from './helpers.js';

let ctx: Ctx;
beforeAll(async () => {
  ctx = await createCtx();
});
afterAll(() => ctx.close());
beforeEach(() => ctx.reset());

const EMAIL = 'new.student@example.com';
const PASSWORD = 'Sup3rSecret!';

/** Sign up and verify. Returns the session. */
async function signUp(email = EMAIL, password = PASSWORD, name = 'New Student') {
  const reg = await ctx.call('POST', '/v1/auth/register', { body: { name, email, password } });
  expect(reg.status).toBe(200);
  const code = ctx.mailer.lastCode(email);
  const ver = await ctx.call('POST', '/v1/auth/verify-email', { body: { email, code } });
  expect(ver.status).toBe(200);
  return ver.body;
}

/** Confirms the code that was emailed. */
async function verify(email = EMAIL) {
  const res = await ctx.call('POST', '/v1/auth/verify-email', { body: { email, code: ctx.mailer.lastCode(email) } });
  expect(res.status).toBe(200);
  return res.body;
}

/** Expire the cooldown so the next code request is allowed (instead of waiting 60 s). */
const skipCooldown = () => ctx.pool.query(`UPDATE email_otps SET created_at = created_at - interval '2 minutes' WHERE used_at IS NULL`);

describe('sign up', () => {
  it('creates the account only after the emailed code is confirmed, then signs in', async () => {
    const reg = await ctx.call('POST', '/v1/auth/register', { body: { name: 'New Student', email: EMAIL, password: PASSWORD } });
    expect(reg.body).toMatchObject({ ok: true, email: EMAIL });
    expect((await ctx.pool.query('SELECT 1 FROM users WHERE email = $1', [EMAIL])).rowCount).toBe(0);

    const session = await verify();
    expect(session.user).toMatchObject({ email: EMAIL, name: 'New Student' });
    expect(session.accessToken).toBeTruthy();
    const me = await ctx.call('GET', '/v1/me', { token: session.accessToken });
    expect(me.status).toBe(200);
    expect(me.body.membership).toBeNull();
  });

  it('never stores the password or the code in plain text', async () => {
    await ctx.call('POST', '/v1/auth/register', { body: { name: 'New Student', email: EMAIL, password: PASSWORD } });
    const code = ctx.mailer.lastCode(EMAIL);
    const otp = await ctx.pool.query('SELECT code_hash, payload FROM email_otps');
    expect(JSON.stringify(otp.rows)).not.toContain(code);
    expect(JSON.stringify(otp.rows)).not.toContain(PASSWORD);
    await verify();
    const user = await ctx.pool.query('SELECT password_hash FROM users WHERE email = $1', [EMAIL]);
    expect(user.rows[0].password_hash).toMatch(/^scrypt\$/);
    expect(user.rows[0].password_hash).not.toContain(PASSWORD);
  });

  it('sends a branded HTML email with the code, plus a plain-text version', async () => {
    await ctx.call('POST', '/v1/auth/register', { body: { name: 'New Student', email: EMAIL, password: PASSWORD } });
    const mail = ctx.mailer.to(EMAIL)[0];
    expect(mail?.subject).toBe('Verify your email for CampusHub');
    expect(mail?.html).toContain(mail?.code);
    expect(mail?.html).toContain('<!doctype html>');
    expect(mail?.text).toContain(mail?.code);
  });

  it('rejects weak passwords and invalid emails without sending anything', async () => {
    for (const password of ['short1', 'onlyletters', '12345678', EMAIL]) {
      const res = await ctx.call('POST', '/v1/auth/register', { body: { name: 'A B', email: EMAIL, password } });
      expect(res.status).toBe(400);
    }
    expect((await ctx.call('POST', '/v1/auth/register', { body: { name: 'A B', email: 'not-an-email', password: PASSWORD } })).status).toBe(400);
    expect(ctx.mailer.sent).toHaveLength(0);
  });

  it('does not reveal that an email already has an account (the owner gets a notice instead)', async () => {
    await signUp();
    ctx.mailer.reset();
    await skipCooldown();
    const again = await ctx.call('POST', '/v1/auth/register', { body: { name: 'Someone Else', email: EMAIL, password: 'AnotherPass9' } });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, email: EMAIL });
    const mail = ctx.mailer.to(EMAIL)[0];
    expect(mail?.subject).toBe('You already have a CampusHub account');
    expect(mail?.code).toBeUndefined();
    // The original password still works; the attacker changed nothing.
    const login = await ctx.call('POST', '/v1/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    expect(login.status).toBe(200);
  });

  it('lets the person try again at once when the email could not be sent', async () => {
    const realSend = ctx.mailer.send.bind(ctx.mailer);
    ctx.mailer.send = async () => {
      throw new Error('SMTP is down');
    };
    const failed = await ctx.call('POST', '/v1/auth/register', { body: { name: 'New Student', email: EMAIL, password: PASSWORD } });
    ctx.mailer.send = realSend;
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe('email_failed');
    // No cooldown is left behind: the next try goes straight through.
    const retry = await ctx.call('POST', '/v1/auth/register', { body: { name: 'New Student', email: EMAIL, password: PASSWORD } });
    expect(retry.status).toBe(200);
    expect(ctx.mailer.lastCode(EMAIL)).toMatch(/^\d{6}$/);
  });

  it('refuses a second code request inside the cooldown', async () => {
    await ctx.call('POST', '/v1/auth/register', { body: { name: 'New Student', email: EMAIL, password: PASSWORD } });
    const res = await ctx.call('POST', '/v1/auth/register', { body: { name: 'New Student', email: EMAIL, password: PASSWORD } });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('otp_cooldown');
    expect(ctx.mailer.to(EMAIL)).toHaveLength(1);
  });
});

describe('codes', () => {
  it('allows only a few wrong tries, then locks the code even for the right one', async () => {
    await ctx.call('POST', '/v1/auth/register', { body: { name: 'New Student', email: EMAIL, password: PASSWORD } });
    const right = ctx.mailer.lastCode(EMAIL);
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      const res = await ctx.call('POST', '/v1/auth/verify-email', { body: { email: EMAIL, code: wrong } });
      expect(res.status).toBe(400);
    }
    const res = await ctx.call('POST', '/v1/auth/verify-email', { body: { email: EMAIL, code: right } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('otp_locked');
    expect((await ctx.pool.query('SELECT 1 FROM users WHERE email = $1', [EMAIL])).rowCount).toBe(0);
  });

  it('cannot be guessed with parallel requests beyond the limit', async () => {
    await ctx.call('POST', '/v1/auth/register', { body: { name: 'New Student', email: EMAIL, password: PASSWORD } });
    const right = ctx.mailer.lastCode(EMAIL);
    const guesses = Array.from({ length: 40 }, (_, i) => String(i).padStart(6, '0')).filter(g => g !== right);
    await Promise.all(guesses.map(code => ctx.call('POST', '/v1/auth/verify-email', { body: { email: EMAIL, code } })));
    const row = await ctx.pool.query('SELECT attempts FROM email_otps WHERE email = $1', [EMAIL]);
    expect(row.rows[0].attempts).toBe(OTP_MAX_ATTEMPTS);
  });

  it('works once only', async () => {
    await signUp(); // uses the code once
    const reuse = await ctx.call('POST', '/v1/auth/verify-email', { body: { email: EMAIL, code: ctx.mailer.lastCode(EMAIL) } });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error.code).toBe('otp_expired');
  });

  it('expires after ten minutes', async () => {
    await ctx.call('POST', '/v1/auth/register', { body: { name: 'New Student', email: EMAIL, password: PASSWORD } });
    const code = ctx.mailer.lastCode(EMAIL);
    await ctx.pool.query(`UPDATE email_otps SET expires_at = now() - interval '1 second'`);
    const res = await ctx.call('POST', '/v1/auth/verify-email', { body: { email: EMAIL, code } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('otp_expired');
  });

  it('a new code replaces the old one', async () => {
    await ctx.call('POST', '/v1/auth/register', { body: { name: 'New Student', email: EMAIL, password: PASSWORD } });
    const first = ctx.mailer.lastCode(EMAIL);
    await skipCooldown();
    const resend = await ctx.call('POST', '/v1/auth/otp/resend', { body: { email: EMAIL, purpose: 'signup' } });
    expect(resend.status).toBe(200);
    const second = ctx.mailer.lastCode(EMAIL);
    if (first !== second) {
      const old = await ctx.call('POST', '/v1/auth/verify-email', { body: { email: EMAIL, code: first } });
      expect(old.status).toBe(400);
    }
    const ok = await ctx.call('POST', '/v1/auth/verify-email', { body: { email: EMAIL, code: second } });
    expect(ok.status).toBe(200);
  });

  it('resend needs an earlier request (it cannot be used to mail strangers)', async () => {
    const res = await ctx.call('POST', '/v1/auth/otp/resend', { body: { email: 'stranger@example.com', purpose: 'signup' } });
    expect(res.status).toBe(400);
    expect(ctx.mailer.sent).toHaveLength(0);
  });
});

describe('sign in', () => {
  it('password first, then the emailed code (two-step)', async () => {
    await signUp();
    ctx.mailer.reset();
    const step1 = await ctx.call('POST', '/v1/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    expect(step1.status).toBe(200);
    expect(step1.body.status).toBe('otp_required');
    expect(step1.body.accessToken).toBeUndefined();
    expect(ctx.mailer.to(EMAIL)[0]?.subject).toBe('Your CampusHub sign-in code');

    const step2 = await ctx.call('POST', '/v1/auth/login/verify', { body: { email: EMAIL, code: ctx.mailer.lastCode(EMAIL) } });
    expect(step2.status).toBe(200);
    expect(step2.body.status).toBe('ok');
    expect((await ctx.call('GET', '/v1/me', { token: step2.body.accessToken })).status).toBe(200);
  });

  it('a sign-in code cannot be used before the password step asked for one', async () => {
    await signUp();
    const res = await ctx.call('POST', '/v1/auth/login/verify', { body: { email: EMAIL, code: '123456' } });
    expect(res.status).toBe(400);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    await signUp();
    const wrong = await ctx.call('POST', '/v1/auth/login', { body: { email: EMAIL, password: 'WrongPass123' } });
    const unknown = await ctx.call('POST', '/v1/auth/login', { body: { email: 'nobody@example.com', password: 'WrongPass123' } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('locks the account for a while after too many wrong passwords', async () => {
    await signUp();
    for (let i = 0; i < 8; i++) {
      await ctx.call('POST', '/v1/auth/login', { body: { email: EMAIL, password: 'WrongPass123' } });
    }
    const locked = await ctx.call('POST', '/v1/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('account_locked');
  });

  it('can skip the second step when two-step sign-in is switched off', async () => {
    const plain = await createCtx({ requireLoginOtp: false });
    try {
      await plain.reset();
      await plain.call('POST', '/v1/auth/register', { body: { name: 'New Student', email: EMAIL, password: PASSWORD } });
      await plain.call('POST', '/v1/auth/verify-email', { body: { email: EMAIL, code: plain.mailer.lastCode(EMAIL) } });
      const res = await plain.call('POST', '/v1/auth/login', { body: { email: EMAIL, password: PASSWORD } });
      expect(res.body.status).toBe('ok');
      expect(res.body.accessToken).toBeTruthy();
    } finally {
      await plain.reset();
      await plain.close();
    }
  });

  it('a Google-only account cannot sign in with a password', async () => {
    await ctx.user({ email: 'google.person@example.com' });
    const res = await ctx.call('POST', '/v1/auth/login', { body: { email: 'google.person@example.com', password: PASSWORD } });
    expect(res.status).toBe(401);
  });
});

describe('forgot password', () => {
  it('resets with the emailed code, signs out everywhere and lets the new password in', async () => {
    const session = await signUp();
    ctx.mailer.reset();
    const forgot = await ctx.call('POST', '/v1/auth/forgot', { body: { email: EMAIL } });
    expect(forgot.body.ok).toBe(true);
    expect(ctx.mailer.to(EMAIL)[0]?.subject).toBe('Reset your CampusHub password');

    const reset = await ctx.call('POST', '/v1/auth/reset', { body: { email: EMAIL, code: ctx.mailer.lastCode(EMAIL), newPassword: 'BrandNew#2024' } });
    expect(reset.status).toBe(200);
    expect(ctx.mailer.to(EMAIL).some(m => m.subject === 'Your CampusHub password was changed')).toBe(true);

    // The old session's refresh token no longer works.
    const refresh = await ctx.call('POST', '/v1/auth/refresh', { body: { refreshToken: session.refreshToken } });
    expect(refresh.status).toBe(401);
    // Old password is dead, new one works.
    expect((await ctx.call('POST', '/v1/auth/login', { body: { email: EMAIL, password: PASSWORD } })).status).toBe(401);
    expect((await ctx.call('POST', '/v1/auth/login', { body: { email: EMAIL, password: 'BrandNew#2024' } })).body.status).toBe('otp_required');
  });

  it('answers the same for an unknown email and sends nothing', async () => {
    const res = await ctx.call('POST', '/v1/auth/forgot', { body: { email: 'nobody@example.com' } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(ctx.mailer.sent).toHaveLength(0);
    const reset = await ctx.call('POST', '/v1/auth/reset', { body: { email: 'nobody@example.com', code: '123456', newPassword: 'BrandNew#2024' } });
    expect(reset.status).toBe(400);
  });

  it('rejects a weak new password without spending a try', async () => {
    await signUp();
    await ctx.call('POST', '/v1/auth/forgot', { body: { email: EMAIL } });
    const weak = await ctx.call('POST', '/v1/auth/reset', { body: { email: EMAIL, code: ctx.mailer.lastCode(EMAIL), newPassword: 'weak' } });
    expect(weak.status).toBe(400);
    const row = await ctx.pool.query(`SELECT attempts FROM email_otps WHERE email = $1 AND purpose = 'reset'`, [EMAIL]);
    expect(row.rows[0].attempts).toBe(0);
  });

  it('lets a Google-created account set a password (the code proves the email)', async () => {
    await ctx.user({ email: 'google.person@example.com' });
    await ctx.call('POST', '/v1/auth/forgot', { body: { email: 'google.person@example.com' } });
    const code = ctx.mailer.lastCode('google.person@example.com');
    const reset = await ctx.call('POST', '/v1/auth/reset', { body: { email: 'google.person@example.com', code, newPassword: 'FreshPass#77' } });
    expect(reset.status).toBe(200);
  });
});

describe('development outbox', () => {
  it('lists the emails sent, but only while the in-memory mailer is used', async () => {
    await ctx.call('POST', '/v1/auth/register', { body: { name: 'New Student', email: EMAIL, password: PASSWORD } });
    const res = await ctx.call('GET', `/v1/dev/outbox?to=${encodeURIComponent(EMAIL)}`);
    expect(res.status).toBe(200);
    expect(res.body.emails[0].code).toBe(ctx.mailer.lastCode(EMAIL));
  });
});
