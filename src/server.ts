import 'dotenv/config';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { startReminderJob } from './jobs/reminders.js';
import { createMailer } from './mail/mailer.js';
import { createStorage } from './storage/index.js';
import { FcmPush, LogPush, type PushProvider } from './push/index.js';
import { Notifier } from './push/notifier.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);

// Bring the schema up to date before taking traffic. Safe to run on every start.
const result = await migrate(pool);
if (result.applied.length > 0) {
  console.log(`Applied migrations: ${result.applied.join(', ')}`);
}

const push: PushProvider = config.firebaseServiceAccount ? new FcmPush(config, pool) : new LogPush();
const mailer = createMailer(config);
const storage = createStorage(config.uploadsDir);
const app = await buildApp({ config, pool, push, mailer, storage });
const stopJobs = config.runJobs ? startReminderJob(pool, new Notifier(pool, push)) : () => undefined;

await app.listen({ port: config.port, host: config.host });
app.log.info(`CampusHub API ready (auth: ${config.authMode}, push: ${config.firebaseServiceAccount ? 'FCM' : 'log only'}, email: ${mailer.kind === 'smtp' ? (mailer.outbox ? 'SMTP (fake addresses stay in memory)' : 'SMTP') : 'in memory (development)'})`);

async function shutdown(signal: string) {
  app.log.info(`${signal} received, shutting down`);
  stopJobs();
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
