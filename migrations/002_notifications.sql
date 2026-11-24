-- Notification inbox. Every notification is saved here AND sent as a push. The inbox is the source
-- of truth: it works without push (no Firebase, notifications switched off on the phone, a new
-- device) and shows the same list on every device.

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'official' CHECK (kind IN ('official', 'society', 'alert')),
  title       text NOT NULL,
  body        text NOT NULL,
  post_id     uuid REFERENCES posts(id) ON DELETE CASCADE,
  event_id    uuid REFERENCES events(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz
);
CREATE INDEX notifications_user_created_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;
