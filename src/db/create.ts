import pg from 'pg';
import { fileURLToPath } from 'node:url';

/** Creates the database named in `url` if it does not exist yet. */
export async function ensureDatabase(url: string): Promise<boolean> {
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.replace(/^\//, ''));
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`Unsafe database name: ${name}`);
  }
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (exists.rowCount === 0) {
      await client.query(`CREATE DATABASE "${name}"`);
      return true;
    }
    return false;
  } finally {
    await client.end();
  }
}

// CLI: `npm run db:create`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await import('dotenv/config');
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set (see .env.example).');
    process.exit(1);
  }
  const created = await ensureDatabase(url);
  console.log(created ? 'Database created.' : 'Database already exists.');
}
