import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { createCtx, type Ctx } from './helpers.js';

let t: Ctx;
beforeAll(async () => {
  t = await createCtx();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

describe('sign in and sessions', () => {
  it('creates an account on first sign-in and returns the same one next time', async () => {
    const a = await t.call('POST', '/v1/auth/dev', { body: { email: 'new@student.test', name: 'New Student' } });
    expect(a.status).toBe(200);
    expect(a.body.user).toMatchObject({ email: 'new@student.test', name: 'New Student' });
    expect(a.body.accessToken).toBeTruthy();
    expect(a.body.refreshToken).toBeTruthy();

    const b = await t.call('POST', '/v1/auth/dev', { body: { email: 'NEW@student.test' } });
    expect(b.body.user.uid).toBe(a.body.user.uid); // same person, email is case-insensitive
  });

  it('signing in again without a name keeps the stored name', async () => {
    await t.call('POST', '/v1/auth/dev', { body: { email: 'keep@student.test', name: 'Keep Me' } });
    const again = await t.call('POST', '/v1/auth/dev', { body: { email: 'keep@student.test' } });
    expect(again.body.user.name).toBe('Keep Me');
    const renamed = await t.call('POST', '/v1/auth/dev', { body: { email: 'keep@student.test', name: 'New Name' } });
    expect(renamed.body.user.name).toBe('New Name');
  });

  it('rejects a missing, malformed or forged token', async () => {
    expect((await t.call('GET', '/v1/me')).status).toBe(401);
    expect((await t.call('GET', '/v1/me', { token: 'not-a-token' })).status).toBe(401);
    const forged = (await t.call('POST', '/v1/auth/dev', { body: { email: 'a@b.test' } })).body.accessToken as string;
    const tampered = forged.slice(0, -4) + 'AAAA';
    expect((await t.call('GET', '/v1/me', { token: tampered })).status).toBe(401);
  });

  it('/me shows no membership until the student joins a university', async () => {
    const s = (await t.call('POST', '/v1/auth/dev', { body: { email: 'x@y.test' } })).body;
    const me = await t.call('GET', '/v1/me', { token: s.accessToken });
    expect(me.status).toBe(200);
    expect(me.body.membership).toBeNull();
    expect(me.body.university).toBeNull();
  });

  it('refresh tokens work once, then are revoked (rotation)', async () => {
    const s = (await t.call('POST', '/v1/auth/dev', { body: { email: 'r@y.test' } })).body;
    const next = await t.call('POST', '/v1/auth/refresh', { body: { refreshToken: s.refreshToken } });
    expect(next.status).toBe(200);
    expect(next.body.refreshToken).not.toBe(s.refreshToken);
    // The old one cannot be replayed.
    expect((await t.call('POST', '/v1/auth/refresh', { body: { refreshToken: s.refreshToken } })).status).toBe(401);
    // The new access token works.
    expect((await t.call('GET', '/v1/me', { token: next.body.accessToken })).status).toBe(200);
  });

  it('only one of two simultaneous refreshes succeeds', async () => {
    const s = (await t.call('POST', '/v1/auth/dev', { body: { email: 'race@y.test' } })).body;
    const results = await Promise.all([1, 2, 3, 4].map(() => t.call('POST', '/v1/auth/refresh', { body: { refreshToken: s.refreshToken } })));
    expect(results.filter(r => r.status === 200)).toHaveLength(1);
  });

  it('logout revokes the refresh token', async () => {
    const s = (await t.call('POST', '/v1/auth/dev', { body: { email: 'l@y.test' } })).body;
    expect((await t.call('POST', '/v1/auth/logout', { body: { refreshToken: s.refreshToken } })).status).toBe(204);
    expect((await t.call('POST', '/v1/auth/refresh', { body: { refreshToken: s.refreshToken } })).status).toBe(401);
  });

  it('validates input', async () => {
    const r = await t.call('POST', '/v1/auth/dev', { body: { email: 'not-an-email' } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('validation_failed');
  });
});

describe('safety of dev sign-in', () => {
  it('is switched off when the server runs in firebase mode', async () => {
    const prod = await createCtx({ authMode: 'firebase', firebaseServiceAccount: 'x.json' });
    try {
      expect((await prod.call('POST', '/v1/auth/dev', { body: { email: 'a@b.test' } })).status).toBe(404);
      expect((await prod.call('GET', '/v1/dev/accounts')).status).toBe(404);
    } finally {
      await prod.close();
    }
  });

  it('refuses to start in production with dev sign-in', () => {
    const env = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://x', JWT_SECRET: 'x'.repeat(40), AUTH_MODE: 'dev' } as NodeJS.ProcessEnv;
    expect(() => loadConfig(env)).toThrow(/not allowed in production/);
  });

  it('production defaults to firebase and needs the service account', () => {
    const env = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://x', JWT_SECRET: 'x'.repeat(40) } as NodeJS.ProcessEnv;
    expect(() => loadConfig(env)).toThrow(/FIREBASE_SERVICE_ACCOUNT/);
  });

  it('rejects a weak JWT secret', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgresql://x', JWT_SECRET: 'short' } as NodeJS.ProcessEnv)).toThrow(/JWT_SECRET/);
  });
});
