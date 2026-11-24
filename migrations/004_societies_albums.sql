-- Module 4: societies and photo albums.
--
-- Isolation is enforced by the database itself: every table that points at another university-owned row
-- does so through a COMPOSITE foreign key that includes university_id, so a row can never reference
-- something that belongs to a different university, whatever the application code does.

-- Targets for the composite keys (ids are already unique; the pair is what makes the key usable).
ALTER TABLE memberships ADD CONSTRAINT memberships_user_university_key UNIQUE (user_id, university_id);
ALTER TABLE events      ADD CONSTRAINT events_id_university_key         UNIQUE (id, university_id);

-- ── Societies ────────────────────────────────────────────────────────────────

CREATE TABLE societies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id text NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  about         text NOT NULL DEFAULT '' CHECK (char_length(about) <= 500),
  category      text NOT NULL CHECK (category IN ('Tech', 'Sports', 'Cultural', 'Career', 'Social')),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, university_id)
);
CREATE UNIQUE INDEX societies_name_key ON societies (university_id, lower(name));

CREATE TABLE society_members (
  society_id    uuid NOT NULL,
  user_id       uuid NOT NULL,
  university_id text NOT NULL,
  role          text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'head')),
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (society_id, user_id),
  FOREIGN KEY (society_id, university_id) REFERENCES societies (id, university_id) ON DELETE CASCADE,
  -- The person must belong to that same university. Leaving the university removes the rows.
  FOREIGN KEY (user_id, university_id) REFERENCES memberships (user_id, university_id) ON DELETE CASCADE
);
CREATE INDEX society_members_user_idx ON society_members (user_id);

-- Updates and events can belong to a society. Deleting the society keeps them (they just lose the link).
ALTER TABLE posts  ADD COLUMN society_id uuid;
ALTER TABLE events ADD COLUMN society_id uuid;
ALTER TABLE posts  ADD FOREIGN KEY (society_id, university_id) REFERENCES societies (id, university_id) ON DELETE SET NULL (society_id);
ALTER TABLE events ADD FOREIGN KEY (society_id, university_id) REFERENCES societies (id, university_id) ON DELETE SET NULL (society_id);
ALTER TABLE posts  ADD CONSTRAINT posts_society_only_for_society_kind CHECK (society_id IS NULL OR kind = 'society');
CREATE INDEX events_society_idx ON events (society_id, starts_at);
CREATE INDEX posts_society_idx  ON posts (society_id, created_at DESC);

-- ── Photo albums ─────────────────────────────────────────────────────────────

CREATE TABLE albums (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id text NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  title         text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 80),
  category      text NOT NULL CHECK (category IN ('Tech', 'Sports', 'Cultural', 'Career', 'Social')),
  event_id      uuid,
  society_id    uuid,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, university_id),
  FOREIGN KEY (event_id, university_id)   REFERENCES events (id, university_id)    ON DELETE SET NULL (event_id),
  FOREIGN KEY (society_id, university_id) REFERENCES societies (id, university_id) ON DELETE SET NULL (society_id)
);
CREATE INDEX albums_university_idx ON albums (university_id, created_at DESC);

CREATE TABLE photos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  album_id      uuid NOT NULL,
  university_id text NOT NULL,
  uploader_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  storage_key   text NOT NULL,
  thumb_key     text NOT NULL,
  width         integer NOT NULL CHECK (width > 0),
  height        integer NOT NULL CHECK (height > 0),
  bytes         integer NOT NULL CHECK (bytes > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (album_id, university_id) REFERENCES albums (id, university_id) ON DELETE CASCADE
);
CREATE INDEX photos_album_idx    ON photos (album_id, created_at DESC);
CREATE INDEX photos_uploader_idx ON photos (uploader_id, created_at DESC);

CREATE TABLE photo_likes (
  photo_id   uuid NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (photo_id, user_id)
);
