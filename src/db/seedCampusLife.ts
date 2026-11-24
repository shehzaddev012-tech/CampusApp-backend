import type pg from 'pg';

/**
 * Development data: some lost-and-found posts and event check-ins that look like a campus in use.
 * Safe to run again: it does nothing once IAC has lost-and-found posts.
 */

const LOST = [
  { kind: 'lost', title: 'Black wallet', description: 'Leather wallet with my student card inside. Reward for return.', place: 'Cafeteria' },
  { kind: 'found', title: 'Blue water bottle', description: 'Steel bottle with stickers, found on a bench.', place: 'Library lawn' },
  { kind: 'lost', title: 'Casio calculator', description: 'Scientific calculator with my initials on the back.', place: 'Block C, Room 204' },
  { kind: 'found', title: 'Set of keys', description: 'Three keys on a red keyring. Handed to the guard room.', place: 'Main gate' },
];

export async function seedCampusLife(pool: pg.Pool, ids: Map<string, string>, fillers: string[]): Promise<void> {
  const done = await pool.query("SELECT 1 FROM lost_items WHERE university_id = 'iac' LIMIT 1");
  if (done.rowCount) {
    return;
  }

  const posters = [ids.get('ayesha@iac.test'), fillers[2], fillers[5], ids.get('bilal@iac.test')].filter(Boolean) as string[];
  for (const [i, item] of LOST.entries()) {
    await pool.query(
      `INSERT INTO lost_items (university_id, created_by, kind, title, description, place, created_at)
       VALUES ('iac', $1, $2, $3, $4, $5, now() - make_interval(hours => $6))`,
      [posters[i % posters.length], item.kind, item.title, item.description, item.place, (i + 1) * 7],
    );
  }

  // Check-ins: the past hackathon for most ticket holders, the live Tech Fest for a few.
  const events = await pool.query<{ id: string; title: string }>("SELECT id, title FROM events WHERE university_id = 'iac' AND title IN ('Hackathon Finals', 'Tech Fest 2026')");
  for (const ev of events.rows) {
    const going = await pool.query<{ user_id: string }>("SELECT user_id FROM rsvps WHERE event_id = $1 AND status = 'going' ORDER BY created_at, user_id", [ev.id]);
    const take = ev.title === 'Tech Fest 2026' ? 10 : Math.ceil(going.rows.length * 0.8);
    for (const r of going.rows.slice(0, take)) {
      await pool.query("UPDATE rsvps SET checked_in_at = COALESCE(checked_in_at, now() - interval '30 minutes') WHERE event_id = $1 AND user_id = $2", [ev.id, r.user_id]);
    }
  }
}
