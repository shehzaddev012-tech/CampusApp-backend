import 'dotenv/config';

import os from 'node:os';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

import { buildApp } from '../src/app.js';
import { signAccessToken } from '../src/auth/tokens.js';
import type { Config } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import type { MemberStatus, Role } from '../src/domain.js';
import { MemoryMailer } from '../src/mail/mailer.js';
import { createStorage } from '../src/storage/index.js';
import { LogPush } from '../src/push/index.js';

/** Tests run against a REAL PostgreSQL database, never the development one. */
export function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) {
    return process.env.TEST_DATABASE_URL;
  }
  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error('Set DATABASE_URL (or TEST_DATABASE_URL) in .env so the tests can reach PostgreSQL.');
  }
  const url = new URL(base);
  url.pathname = '/campushub_test';
  return url.toString();
}

export const testConfig = (over: Partial<Config> = {}): Config => ({
  nodeEnv: 'test',
  port: 0,
  host: '127.0.0.1',
  databaseUrl: testDatabaseUrl(),
  jwtSecret: 'test-secret-test-secret-test-secret-test-secret',
  authMode: 'dev',
  accessTtlSeconds: 3600,
  refreshTtlDays: 30,
  corsOrigin: '*',
  runJobs: false,
  requireLoginOtp: true,
  uploadsDir: path.join(os.tmpdir(), 'campushub-test-uploads'),
  ...over,
});

export interface Ctx {
  app: FastifyInstance;
  pool: pg.Pool;
  push: LogPush;
  mailer: MemoryMailer;
  config: Config;
  reset: () => Promise<void>;
  close: () => Promise<void>;
  call: (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, opts?: { token?: string; body?: unknown }) => Promise<{ status: number; body: any }>;
  /** POST multipart/form-data with files in the field "photos". */
  upload: (url: string, token: string, files: { name: string; data: Buffer; type?: string }[], fields?: Record<string, string>) => Promise<{ status: number; body: any }>;
  universe: (id: string, departments?: string[]) => Promise<void>;
  user: (o: UserOptions) => Promise<TestUser>;
}

export interface UserOptions {
  email: string;
  name?: string;
  uni?: string;
  role?: Role;
  status?: MemberStatus;
  department?: string;
  studentId?: string;
  batch?: string;
}

export interface TestUser {
  id: string;
  email: string;
  name: string;
  token: string;
  /** For a society head: the society they head. */
  societyId?: string;
}

let counter = 0;

export async function createCtx(configOver: Partial<Config> = {}): Promise<Ctx> {
  const config = testConfig(configOver);
  const pool = createPool(config.databaseUrl);
  const push = new LogPush();
  const mailer = new MemoryMailer();
  const app = await buildApp({ config, pool, push, mailer, storage: createStorage(config.uploadsDir) });
  await app.ready();

  const reset = async () => {
    await pool.query('TRUNCATE users, universities, email_otps RESTART IDENTITY CASCADE');
    push.reset();
    mailer.reset();
  };

  const call: Ctx['call'] = async (method, url, opts = {}) => {
    const res = await app.inject({
      method,
      url,
      headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
      payload: opts.body === undefined ? undefined : (opts.body as object),
    });
    let body: unknown = null;
    try {
      body = res.body ? JSON.parse(res.body) : null;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body };
  };

  const upload: Ctx['upload'] = async (url, token, files, fields = {}) => {
    const boundary = '----campushubtest' + Math.random().toString(16).slice(2);
    const chunks: Buffer[] = [];
    for (const [k, v] of Object.entries(fields)) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    for (const f of files) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photos"; filename="${f.name}"\r\nContent-Type: ${f.type ?? 'image/jpeg'}\r\n\r\n`), f.data, Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat(chunks),
    });
    let body: unknown = null;
    try {
      body = res.body ? JSON.parse(res.body) : null;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body };
  };

  const universe: Ctx['universe'] = async (id, departments = ['Computer Science', 'Business']) => {
    await pool.query('INSERT INTO universities (id, name, full_name, accent) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [id, id.toUpperCase(), `${id.toUpperCase()} Campus`, '#4F46E5']);
    for (const d of departments) {
      await pool.query('INSERT INTO departments (university_id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, d]);
    }
  };

  const user: Ctx['user'] = async o => {
    // Capture the number NOW: several users are created at once, and `counter` moves while we await.
    const n = ++counter;
    const name = o.name ?? o.email.split('@')[0] ?? 'User';
    const u = await pool.query<{ id: string }>('INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id', [o.email, name]);
    const id = (u.rows[0] as { id: string }).id;
    if (o.uni) {
      await pool.query(
        'INSERT INTO memberships (user_id, university_id, student_id, department, batch, role, status) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [id, o.uni, o.studentId ?? `ID-${n}`, o.department ?? 'Computer Science', o.batch ?? '2024', o.role ?? 'student', o.status ?? 'active'],
      );
    }
    // A society head always heads a society, so every test head gets one of their own.
    let societyId: string | undefined;
    if (o.uni && o.role === 'society_head' && (o.status ?? 'active') === 'active') {
      const s = await pool.query<{ id: string }>(
        `INSERT INTO societies (university_id, name, about, category) VALUES ($1, $2, '', 'Tech') RETURNING id`,
        [o.uni, `${name} Society ${n}`],
      );
      societyId = (s.rows[0] as { id: string }).id;
      await pool.query(`INSERT INTO society_members (society_id, user_id, university_id, role) VALUES ($1, $2, $3, 'head')`, [societyId, id, o.uni]);
    }
    return { id, email: o.email, name, token: await signAccessToken(config, id), societyId };
  };

  return { app, pool, push, mailer, config, reset, call, upload, universe, user, close: async () => { await app.close(); await pool.end(); } };
}

const HOUR = 3_600_000;

/** Request body for POST /v1/events. Times are relative to now. */
export const eventBody = (over: Record<string, unknown> = {}) => ({
  title: 'Test Event',
  organizer: 'Test Society',
  category: 'Tech',
  blurb: 'An event created by the automated tests.',
  venue: 'Main Hall',
  startsAt: Date.now() + HOUR,
  endsAt: Date.now() + 3 * HOUR,
  capacity: null,
  volunteersNeeded: 0,
  isPublic: false,
  ...over,
});

export const HOURS = HOUR;
