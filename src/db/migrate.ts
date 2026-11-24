import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

import { createPool } from './pool.js';

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);
/** Arbitrary constant: only one process may migrate at a time. */
const LOCK_ID = 727_001;

export interface MigrationResult {
  applied: string[];
  alreadyApplied: number;
}

/**
 * Applies every `migrations/NNN_name.sql` that has not run yet, in order, each in its own
 * transaction. An already-applied file that was edited afterwards is an error: schema changes
 * go in a NEW migration, never in an old one.
 */
export async function migrate(pool: pg.Pool): Promise<MigrationResult> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);

    const files = (await readdir(MIGRATIONS_DIR)).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
    const done = new Map<string, string>(
      (await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations')).rows.map(
        r => [r.version, r.checksum],
      ),
    );

    const applied: string[] = [];
    for (const file of files) {
      const sql = await readFile(new URL(file, MIGRATIONS_DIR), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = done.get(file);
      if (previous) {
        if (previous !== checksum) {
          throw new Error(`Migration ${file} was changed after it was applied. Add a new migration instead.`);
        }
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    return { applied, alreadyApplied: done.size };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

// CLI: `npm run migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await import('dotenv/config');
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set (see .env.example).');
    process.exit(1);
  }
  const pool = createPool(url);
  try {
    const r = await migrate(pool);
    console.log(r.applied.length ? `Applied: ${r.applied.join(', ')}` : 'Database is up to date.');
  } finally {
    await pool.end();
  }
}
