-- Module 11: pictures and documents in chats, and emoji reactions on messages.

-- A message may now be only a picture or a document (the text is then an optional caption).
-- The API still requires 1-1000 characters for a plain text message.
ALTER TABLE messages DROP CONSTRAINT messages_body_check;
ALTER TABLE messages ADD CONSTRAINT messages_body_check CHECK (char_length(body) <= 1000);

CREATE TABLE message_attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    uuid NOT NULL UNIQUE,
  university_id text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('image', 'file')),
  storage_key   text NOT NULL,
  thumb_key     text,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  mime          text NOT NULL,
  bytes         integer NOT NULL CHECK (bytes > 0),
  width         integer,
  height        integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (message_id, university_id) REFERENCES messages (id, university_id) ON DELETE CASCADE
);

-- Whenever an attachment row disappears (the message was deleted, the group was deleted, the student left the
-- university ...) its files go to the trash list, and the server deletes them from storage. Nothing is orphaned.
CREATE TABLE file_trash (
  id          bigserial PRIMARY KEY,
  storage_key text NOT NULL,
  thumb_key   text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION trash_attachment_files() RETURNS trigger AS $$
BEGIN
  INSERT INTO file_trash (storage_key, thumb_key) VALUES (OLD.storage_key, OLD.thumb_key);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER message_attachments_trash AFTER DELETE ON message_attachments
  FOR EACH ROW EXECUTE FUNCTION trash_attachment_files();

-- One reaction per person per message (they can change it), from a fixed set of emojis.
CREATE TABLE message_reactions (
  message_id    uuid NOT NULL,
  university_id text NOT NULL,
  user_id       uuid NOT NULL,
  emoji         text NOT NULL CHECK (emoji IN ('👍', '❤️', '😂', '😮', '😢', '🙏')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id),
  FOREIGN KEY (message_id, university_id) REFERENCES messages (id, university_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, university_id)    REFERENCES memberships (user_id, university_id) ON DELETE CASCADE
);
