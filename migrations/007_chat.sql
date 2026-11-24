-- Module 7: chat (one-to-one, society rooms, study-group rooms) and blocking.
-- Every row is tied to a membership, so a student leaving the university takes their messages with them,
-- and nothing can cross from one university to another.

CREATE TABLE conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id   text NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('dm', 'society', 'group')),
  user_a          uuid,
  user_b          uuid,
  society_id      uuid,
  group_id        uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz,
  UNIQUE (id, university_id),
  CHECK (
    (kind = 'dm'      AND user_a IS NOT NULL AND user_b IS NOT NULL AND user_a < user_b AND society_id IS NULL AND group_id IS NULL) OR
    (kind = 'society' AND society_id IS NOT NULL AND user_a IS NULL AND user_b IS NULL AND group_id IS NULL) OR
    (kind = 'group'   AND group_id IS NOT NULL AND user_a IS NULL AND user_b IS NULL AND society_id IS NULL)
  ),
  FOREIGN KEY (user_a, university_id)    REFERENCES memberships (user_id, university_id) ON DELETE CASCADE,
  FOREIGN KEY (user_b, university_id)    REFERENCES memberships (user_id, university_id) ON DELETE CASCADE,
  FOREIGN KEY (society_id, university_id) REFERENCES societies (id, university_id) ON DELETE CASCADE,
  FOREIGN KEY (group_id, university_id)   REFERENCES study_groups (id, university_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX conversations_dm_key ON conversations (university_id, user_a, user_b) WHERE kind = 'dm';
CREATE UNIQUE INDEX conversations_society_key ON conversations (society_id) WHERE kind = 'society';
CREATE UNIQUE INDEX conversations_group_key ON conversations (group_id) WHERE kind = 'group';
CREATE INDEX conversations_user_a_idx ON conversations (user_a) WHERE kind = 'dm';
CREATE INDEX conversations_user_b_idx ON conversations (user_b) WHERE kind = 'dm';

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  university_id   text NOT NULL,
  sender_id       uuid NOT NULL,
  body            text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, university_id),
  FOREIGN KEY (conversation_id, university_id) REFERENCES conversations (id, university_id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id, university_id)       REFERENCES memberships (user_id, university_id) ON DELETE CASCADE
);
CREATE INDEX messages_conv_idx ON messages (conversation_id, created_at DESC);

CREATE TABLE conversation_reads (
  conversation_id uuid NOT NULL,
  university_id   text NOT NULL,
  user_id         uuid NOT NULL,
  last_read_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id),
  FOREIGN KEY (conversation_id, university_id) REFERENCES conversations (id, university_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, university_id)         REFERENCES memberships (user_id, university_id) ON DELETE CASCADE
);

CREATE TABLE user_blocks (
  blocker_id    uuid NOT NULL,
  blocked_id    uuid NOT NULL,
  university_id text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id),
  FOREIGN KEY (blocker_id, university_id) REFERENCES memberships (user_id, university_id) ON DELETE CASCADE,
  FOREIGN KEY (blocked_id, university_id) REFERENCES memberships (user_id, university_id) ON DELETE CASCADE
);
