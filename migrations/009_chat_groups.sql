-- Module 10: chat groups that students create themselves (like a WhatsApp group).
-- A group is a conversation of kind 'custom' with its own member list and admins.
-- New members see only what is said after they join.

ALTER TABLE conversations
  ADD COLUMN name             text,
  ADD COLUMN about            text NOT NULL DEFAULT '',
  ADD COLUMN created_by       uuid,
  ADD COLUMN only_admins_post boolean NOT NULL DEFAULT false;

ALTER TABLE conversations DROP CONSTRAINT conversations_kind_check;
ALTER TABLE conversations DROP CONSTRAINT conversations_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_kind_check CHECK (kind IN ('dm', 'society', 'group', 'custom'));
ALTER TABLE conversations ADD CONSTRAINT conversations_check CHECK (
  (kind = 'dm'      AND user_a IS NOT NULL AND user_b IS NOT NULL AND user_a < user_b AND society_id IS NULL AND group_id IS NULL) OR
  (kind = 'society' AND society_id IS NOT NULL AND user_a IS NULL AND user_b IS NULL AND group_id IS NULL) OR
  (kind = 'group'   AND group_id IS NOT NULL AND user_a IS NULL AND user_b IS NULL AND society_id IS NULL) OR
  (kind = 'custom'  AND name IS NOT NULL AND char_length(name) BETWEEN 2 AND 60 AND char_length(about) <= 300
                    AND user_a IS NULL AND user_b IS NULL AND society_id IS NULL AND group_id IS NULL)
);

CREATE TABLE conversation_members (
  conversation_id uuid NOT NULL,
  university_id   text NOT NULL,
  user_id         uuid NOT NULL,
  role            text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  joined_at       timestamptz NOT NULL DEFAULT now(),
  added_by        uuid,
  PRIMARY KEY (conversation_id, user_id),
  FOREIGN KEY (conversation_id, university_id) REFERENCES conversations (id, university_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, university_id)         REFERENCES memberships (user_id, university_id) ON DELETE CASCADE
);
CREATE INDEX conversation_members_user_idx ON conversation_members (user_id);
