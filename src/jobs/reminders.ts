import type pg from 'pg';

import type { PushProvider } from '../push/index.js';

const HOUR = 3_600_000;

const WINDOWS = [
  // flag column, window start/end in hours from now, wording
  { flag: 'remind_1h_sent', fromHours: 0.75, toHours: 1.25, text: 'starts in about an hour' },
  { flag: 'remind_24h_sent', fromHours: 23.5, toHours: 24.5, text: 'is tomorrow' },
] as const;

/**
 * Reminds students who hold a ticket one day and one hour before an event.
 * Each reminder is flagged as sent in the same statement that selects the event, so even with
 * several server instances running this job, a reminder goes out exactly once.
 */
export async function runReminders(pool: pg.Pool, push: PushProvider, now = new Date()): Promise<number> {
  let sent = 0;
  for (const w of WINDOWS) {
    const from = new Date(now.getTime() + w.fromHours * HOUR);
    const to = new Date(now.getTime() + w.toHours * HOUR);
    const { rows } = await pool.query<{ id: string; title: string; venue: string }>(
      `UPDATE events SET ${w.flag} = true
        WHERE ${w.flag} = false AND starts_at BETWEEN $1 AND $2
        RETURNING id, title, venue`,
      [from, to],
    );
    for (const event of rows) {
      const going = await pool.query<{ user_id: string }>("SELECT user_id FROM rsvps WHERE event_id = $1 AND status = 'going'", [event.id]);
      await push.sendToUsers(
        going.rows.map(r => r.user_id),
        { title: event.title, body: `${event.title} ${w.text} at ${event.venue}.`, data: { kind: 'official', eventId: event.id } },
      );
      sent += 1;
    }
  }
  return sent;
}

/** Runs the reminder job every few minutes until the returned function is called. */
export function startReminderJob(pool: pg.Pool, push: PushProvider, everyMs = 5 * 60_000): () => void {
  const timer = setInterval(() => {
    runReminders(pool, push).catch(err => console.error('Reminder job failed', err));
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
