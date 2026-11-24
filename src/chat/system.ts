import type { Db } from '../db/pool.js';

/**
 * A line in the middle of a group chat, like WhatsApp's "Hamza added Bilal". It is stored as a message whose
 * sender is the person who did it, so it follows the same rules (a new member does not see what came before).
 */
export async function postSystemMessage(db: Db, conversationId: string, universityId: string, actorId: string, text: string): Promise<void> {
  const { rows } = await db.query<{ created_at: Date }>(
    // clock_timestamp(): the moment it really happens, so people who joined just before it can see it.
    "INSERT INTO messages (conversation_id, university_id, sender_id, body, kind, created_at) VALUES ($1, $2, $3, $4, 'system', clock_timestamp()) RETURNING created_at",
    [conversationId, universityId, actorId, text.slice(0, 500)],
  );
  await db.query('UPDATE conversations SET last_message_at = $2 WHERE id = $1', [conversationId, rows[0]!.created_at]);
}
