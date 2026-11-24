-- Module 12: the rest of the WhatsApp-style chat: replies, deleting, delivery/read ticks, system messages, last seen.

ALTER TABLE messages
  ADD COLUMN kind       text NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'system')),
  ADD COLUMN reply_to   uuid REFERENCES messages (id) ON DELETE SET NULL,
  ADD COLUMN deleted_at timestamptz;

-- When did this person's phone last receive the conversation (the second tick), next to when they last read it (blue ticks).
ALTER TABLE conversation_reads ADD COLUMN last_delivered_at timestamptz;

-- "Delete for me": the message stays for everybody else.
CREATE TABLE message_hidden (
  message_id    uuid NOT NULL,
  university_id text NOT NULL,
  user_id       uuid NOT NULL,
  PRIMARY KEY (message_id, user_id),
  FOREIGN KEY (message_id, university_id) REFERENCES messages (id, university_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, university_id)    REFERENCES memberships (user_id, university_id) ON DELETE CASCADE
);

-- "Last seen": written when a person's last live connection closes.
CREATE TABLE user_presence (
  user_id      uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
