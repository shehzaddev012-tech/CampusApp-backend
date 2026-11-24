import pg from 'pg';

/** Anything that can run a query: the pool, or one client inside a transaction. */
export type Db = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
  // A broken idle connection must not crash the process.
  pool.on('error', err => {
    console.error('Unexpected PostgreSQL pool error', err);
  });
  return pool;
}

/** Runs `fn` in a transaction. Rolls back on any error. */
export async function withTx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
