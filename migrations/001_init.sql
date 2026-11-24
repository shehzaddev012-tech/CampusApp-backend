-- CampusHub schema, version 1.
--
-- Design rules
--   * Every row that belongs to a university carries university_id. The API always takes the
--     university from the caller's membership, never from the request, so one university can
--     never read or write another's data.
--   * Counters (likes, going, checked in ...) are NOT stored. They are counted from the rows, so
--     they can never drift out of sync.
--   * Constraints live in the database (CHECK / UNIQUE / FOREIGN KEY), so a bug in the API
--     cannot produce an invalid state.

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  name        text NOT NULL,
  photo_url   text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE universities (
  id          text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{2,40}$'),
  name        text NOT NULL,
  full_name   text NOT NULL,
  accent      text NOT NULL CHECK (accent ~ '^#[0-9A-Fa-f]{6}$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE departments (
  university_id text NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  name          text NOT NULL,
  PRIMARY KEY (university_id, name)
);

-- A user belongs to at most one university at a time. Leaving deletes the row.
CREATE TABLE memberships (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  university_id text NOT NULL REFERENCES universities(id),
  student_id    text NOT NULL,
  department    text NOT NULL,
  batch         text NOT NULL,
  role          text NOT NULL DEFAULT 'student'
                CHECK (role IN ('student', 'society_head', 'dept_admin', 'uni_admin', 'security')),
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'active', 'rejected', 'suspended')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memberships_university_status_idx ON memberships (university_id, status);
-- One student ID can be claimed once per university.
CREATE UNIQUE INDEX memberships_student_id_key ON memberships (university_id, lower(student_id));

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

CREATE TABLE devices (
  token       text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform    text NOT NULL DEFAULT 'android',
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX devices_user_idx ON devices (user_id);

-- ── Feed (Module 2) ─────────────────────────────────────────────────────────

CREATE TABLE posts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id  text NOT NULL REFERENCES universities(id),
  kind           text NOT NULL CHECK (kind IN ('official', 'society', 'alert')),
  title          text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  body           text NOT NULL CHECK (char_length(body) BETWEEN 10 AND 4000),
  author_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  author_name    text NOT NULL,
  author_role    text NOT NULL,
  source         text NOT NULL,
  channel        text,
  pinned         boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX posts_university_created_idx ON posts (university_id, created_at DESC);

CREATE TABLE post_likes (
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE post_bookmarks (
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX post_bookmarks_user_idx ON post_bookmarks (user_id);

CREATE TABLE post_reads (
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE post_comments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id      uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  author_name  text NOT NULL,
  text         text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 500),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX post_comments_post_idx ON post_comments (post_id, created_at);

-- ── Events (Module 3) ───────────────────────────────────────────────────────

CREATE TABLE events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id     text NOT NULL REFERENCES universities(id),
  title             text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  organizer         text NOT NULL,
  category          text NOT NULL CHECK (category IN ('Tech', 'Sports', 'Cultural', 'Career', 'Social')),
  blurb             text NOT NULL CHECK (char_length(blurb) BETWEEN 10 AND 1500),
  venue             text NOT NULL,
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  capacity          integer CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 100000),
  volunteers_needed integer NOT NULL DEFAULT 0 CHECK (volunteers_needed >= 0),
  is_public         boolean NOT NULL DEFAULT false,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  remind_24h_sent   boolean NOT NULL DEFAULT false,
  remind_1h_sent    boolean NOT NULL DEFAULT false,
  CHECK (ends_at > starts_at)
);
CREATE INDEX events_university_start_idx ON events (university_id, starts_at);

CREATE TABLE event_schedule (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id  uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  at        timestamptz NOT NULL,
  title     text NOT NULL,
  speaker   text
);
CREATE INDEX event_schedule_event_idx ON event_schedule (event_id, at);

-- A student's relationship with one event. status = 'going' IS the ticket; `code` is its secret.
CREATE TABLE rsvps (
  event_id       uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_name   text NOT NULL,
  status         text NOT NULL CHECK (status IN ('going', 'interested', 'waitlist')),
  code           text UNIQUE,
  checked_in_at  timestamptz,
  volunteer      boolean NOT NULL DEFAULT false,
  rating         integer CHECK (rating BETWEEN 1 AND 5),
  feedback       text CHECK (feedback IS NULL OR char_length(feedback) <= 300),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id),
  -- only a going ticket has a code, and a code exists for every going ticket
  CHECK ((status = 'going') = (code IS NOT NULL)),
  -- you cannot be checked in without a ticket
  CHECK (checked_in_at IS NULL OR status = 'going')
);
CREATE INDEX rsvps_event_status_idx ON rsvps (event_id, status, created_at);

CREATE TABLE guest_passes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id  text NOT NULL REFERENCES universities(id),
  event_id       uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  host_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host_name      text NOT NULL,
  guest_name     text NOT NULL CHECK (char_length(guest_name) BETWEEN 2 AND 80),
  guest_phone    text NOT NULL CHECK (char_length(guest_phone) BETWEEN 7 AND 20),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  code           text NOT NULL UNIQUE,
  checked_in_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (checked_in_at IS NULL OR status = 'approved')
);
CREATE INDEX guest_passes_host_idx ON guest_passes (host_id, event_id);
CREATE INDEX guest_passes_pending_idx ON guest_passes (university_id, status);
