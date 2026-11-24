import type { Db } from '../db/pool.js';
import type { Storage } from '../storage/index.js';

/**
 * Deletes, from storage, the files whose database rows are gone (see `file_trash`). Safe to call at any
 * moment and from several servers at once. Returns how many files were removed.
 */
export async function emptyTrash(db: Db, storage: Storage, batch = 200): Promise<number> {
  const { rows } = await db.query<{ storage_key: string; thumb_key: string | null }>(
    `DELETE FROM file_trash WHERE id IN (SELECT id FROM file_trash ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING storage_key, thumb_key`,
    [batch],
  );
  const keys = rows.flatMap(r => [r.storage_key, r.thumb_key]).filter((k): k is string => k !== null);
  await Promise.all(keys.map(k => storage.delete(k).catch(() => undefined)));
  return rows.length;
}
