import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  /** dev = sign in with a test email (never allowed in production). firebase = real Google sign-in. */
  AUTH_MODE: z.enum(['dev', 'firebase']).optional(),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /** Path to the Firebase service-account JSON (needed for Google sign-in and push). */
  FIREBASE_SERVICE_ACCOUNT: z.string().optional(),
  CORS_ORIGIN: z.string().default('*'),
  /** Set to "false" to disable background jobs (event reminders). */
  RUN_JOBS: z.enum(['true', 'false']).default('true'),

  /** Outgoing email (verification codes, password reset). Without SMTP_HOST, emails are kept in memory (development only). */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  /** "true" for port 465, "false" for 587 (STARTTLS). */
  SMTP_SECURE: z.enum(['true', 'false']).default('false'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  /** The "From" address people see, for example: CampusHub <no-reply@yourdomain.com> */
  MAIL_FROM: z.string().optional(),
  /** Where uploaded photos are kept on this server's disk. Back this folder up, and keep it outside the code folder in production. */
  UPLOADS_DIR: z.string().default('./uploads'),
  /** Ask for an emailed code after the password (two-step sign-in). Google sign-in is not affected. */
  REQUIRE_LOGIN_OTP: z.enum(['true', 'false']).default('true'),
});

export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  host: string;
  databaseUrl: string;
  jwtSecret: string;
  authMode: 'dev' | 'firebase';
  accessTtlSeconds: number;
  refreshTtlDays: number;
  firebaseServiceAccount?: string;
  corsOrigin: string;
  runJobs: boolean;
  mail?: MailConfig;
  requireLoginOtp: boolean;
  uploadsDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const authMode = e.AUTH_MODE ?? (e.NODE_ENV === 'production' ? 'firebase' : 'dev');
  if (e.NODE_ENV === 'production' && authMode === 'dev') {
    throw new Error('AUTH_MODE=dev is not allowed in production.');
  }
  if (authMode === 'firebase' && !e.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('AUTH_MODE=firebase needs FIREBASE_SERVICE_ACCOUNT (path to the service-account JSON).');
  }
  if (e.NODE_ENV === 'production' && !e.SMTP_HOST) {
    throw new Error('Production needs SMTP_HOST (and MAIL_FROM): verification codes are sent by email.');
  }
  let mail: MailConfig | undefined;
  if (e.SMTP_HOST) {
    const from = e.MAIL_FROM ?? (e.SMTP_USER ? `CampusHub <${e.SMTP_USER}>` : undefined);
    if (!from) {
      throw new Error('SMTP_HOST needs MAIL_FROM (for example: CampusHub <no-reply@yourdomain.com>).');
    }
    mail = { host: e.SMTP_HOST, port: e.SMTP_PORT, secure: e.SMTP_SECURE === 'true', user: e.SMTP_USER, pass: e.SMTP_PASS, from };
  }
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    databaseUrl: e.DATABASE_URL,
    jwtSecret: e.JWT_SECRET,
    authMode,
    accessTtlSeconds: e.ACCESS_TOKEN_TTL_SECONDS,
    refreshTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
    firebaseServiceAccount: e.FIREBASE_SERVICE_ACCOUNT,
    corsOrigin: e.CORS_ORIGIN,
    runJobs: e.RUN_JOBS === 'true',
    mail,
    requireLoginOtp: e.REQUIRE_LOGIN_OTP === 'true',
    uploadsDir: e.UPLOADS_DIR,
  };
}
