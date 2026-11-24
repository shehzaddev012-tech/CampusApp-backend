import type pg from 'pg';

import { getFirebaseMessaging } from '../auth/firebase.js';
import type { Config } from '../config.js';

export interface PushMessage {
  title: string;
  body: string;
  /** Delivered with the notification so the app can open the right screen. */
  data?: Record<string, string>;
  /** Alerts use high priority so they wake the phone. */
  urgent?: boolean;
}

export interface PushProvider {
  /** Sends to every registered device of every listed user. Never throws. */
  sendToUsers(userIds: string[], message: PushMessage): Promise<void>;
}

/** Keeps messages in memory and logs them. Used in development and in tests. */
export class LogPush implements PushProvider {
  readonly sent: { userIds: string[]; message: PushMessage }[] = [];

  async sendToUsers(userIds: string[], message: PushMessage): Promise<void> {
    if (userIds.length === 0) {
      return;
    }
    this.sent.push({ userIds: [...userIds], message });
    if (process.env.NODE_ENV !== 'test') {
      console.log(`[push] -> ${userIds.length} user(s): ${message.title}`);
    }
  }

  reset() {
    this.sent.length = 0;
  }
}

const BATCH = 500; // FCM multicast limit

/** Real delivery through Firebase Cloud Messaging. */
export class FcmPush implements PushProvider {
  constructor(
    private readonly config: Config,
    private readonly pool: pg.Pool,
  ) {}

  async sendToUsers(userIds: string[], message: PushMessage): Promise<void> {
    if (userIds.length === 0) {
      return;
    }
    try {
      const { rows } = await this.pool.query<{ token: string }>('SELECT token FROM devices WHERE user_id = ANY($1::uuid[])', [userIds]);
      const tokens = rows.map(r => r.token);
      if (tokens.length === 0) {
        return;
      }
      const messaging = await getFirebaseMessaging(this.config);
      for (let i = 0; i < tokens.length; i += BATCH) {
        const chunk = tokens.slice(i, i + BATCH);
        const res = await messaging.sendEachForMulticast({
          tokens: chunk,
          notification: { title: message.title, body: message.body },
          data: message.data ?? {},
          android: { priority: message.urgent ? 'high' : 'normal' },
        });
        // Drop tokens Google says are dead so we stop sending to them.
        const dead = chunk.filter((_, idx) => {
          const code = res.responses[idx]?.error?.code;
          return code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token';
        });
        if (dead.length > 0) {
          await this.pool.query('DELETE FROM devices WHERE token = ANY($1::text[])', [dead]);
        }
      }
    } catch (err) {
      console.error('Push delivery failed', err);
    }
  }
}
