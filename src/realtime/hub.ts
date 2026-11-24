/** The minimum a connection must offer. (The `ws` socket does.) */
export interface Socket {
  readyState: number;
  send(data: string): void;
}

const OPEN = 1;
const MAX_CONNECTIONS_PER_USER = 5;

/**
 * Who is connected right now, so the server can nudge them ("something new in this chat").
 * A nudge carries NO message text: the app asks the normal, permission-checked endpoints for the content.
 * That way real time can never show anyone something the ordinary API would refuse them.
 *
 * Lives in this process. With several API servers behind a load balancer, move the nudge to PostgreSQL
 * LISTEN/NOTIFY (or Redis) so a message handled by one server reaches people connected to another.
 */
export class RealtimeHub {
  private readonly sockets = new Map<string, Set<Socket>>();

  /** False when this person already has too many open connections. */
  add(userId: string, socket: Socket): boolean {
    const set = this.sockets.get(userId) ?? new Set<Socket>();
    if (set.size >= MAX_CONNECTIONS_PER_USER) {
      return false;
    }
    set.add(socket);
    this.sockets.set(userId, set);
    return true;
  }

  /** True when that was the person's last open connection (they just went offline). */
  remove(userId: string, socket: Socket): boolean {
    const set = this.sockets.get(userId);
    if (!set) {
      return false;
    }
    set.delete(socket);
    if (set.size === 0) {
      this.sockets.delete(userId);
      return true;
    }
    return false;
  }

  isOnline(userId: string): boolean {
    return this.sockets.has(userId);
  }

  notify(userIds: readonly string[], event: Record<string, unknown>): void {
    const text = JSON.stringify(event);
    for (const id of userIds) {
      for (const s of this.sockets.get(id) ?? []) {
        if (s.readyState === OPEN) {
          try {
            s.send(text);
          } catch {
            // a dying connection: the close handler removes it
          }
        }
      }
    }
  }

  get connections(): number {
    let n = 0;
    for (const s of this.sockets.values()) {
      n += s.size;
    }
    return n;
  }
}
