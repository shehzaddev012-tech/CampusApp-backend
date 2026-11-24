import type pg from 'pg';

import type { PushMessage, PushProvider } from './index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = new Set(['official', 'society', 'alert']);

/**
 * What the rest of the server calls to tell people something. It saves the notification in each
 * person's inbox first (so it is never lost), then hands it to the push provider.
 */
export class Notifier implements PushProvider {
  constructor(
    private readonly pool: pg.Pool,
    private readonly push: PushProvider,
  ) {}

  async sendToUsers(userIds: string[], message: PushMessage): Promise<void> {
    if (userIds.length === 0) {
      return;
    }
    const kind = KINDS.has(message.data?.kind ?? '') ? (message.data?.kind as string) : 'official';
    const postId = message.data?.postId && UUID.test(message.data.postId) ? message.data.postId : null;
    const eventId = message.data?.eventId && UUID.test(message.data.eventId) ? message.data.eventId : null;
    try {
      await this.pool.query(
        `INSERT INTO notifications (user_id, kind, title, body, post_id, event_id)
         SELECT u, $2, $3, $4, $5, $6 FROM unnest($1::uuid[]) AS u`,
        [userIds, kind, message.title, message.body, postId, eventId],
      );
    } catch (err) {
      console.error('Could not save notifications', err);
    }
    await this.push.sendToUsers(userIds, message);
  }
}
