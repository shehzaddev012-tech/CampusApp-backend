import 'dotenv/config';

import { ensureDatabase } from '../src/db/create.js';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { testDatabaseUrl } from './helpers.js';

/** Runs once before all tests: make sure the test database exists and has the latest schema. */
export default async function setup() {
  const url = testDatabaseUrl();
  await ensureDatabase(url);
  const pool = createPool(url);
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
