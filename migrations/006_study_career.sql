-- Module 6: study (notes and past papers, study groups), book market, jobs and internships, CV.
-- As always: every row that belongs to a person AND a university references memberships (user_id, university_id),
-- so leaving a university removes it, and nothing can ever mix two universities.

-- ── Reports (used by every module that has user content) ─────────────────────
CREATE TABLE content_reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id text NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  reporter_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type   text NOT NULL CHECK (target_type IN ('note', 'book', 'study_group', 'job', 'lost_item', 'photo', 'message', 'user')),
  target_id     uuid NOT NULL,
  reason        text NOT NULL CHECK (reason IN ('spam', 'inappropriate', 'copyright', 'scam', 'harassment', 'other')),
  details       text NOT NULL DEFAULT '' CHECK (char_length(details) <= 500),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  handled_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  handled_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reporter_id, target_type, target_id)
);
CREATE INDEX content_reports_open_idx ON content_reports (university_id, status, created_at);

-- ── Pictures for things other than albums (book photos ...) ─────────────────
CREATE TABLE media (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id text NOT NULL,
  owner_id      uuid NOT NULL,
  storage_key   text NOT NULL,
  thumb_key     text NOT NULL,
  width         integer NOT NULL CHECK (width > 0),
  height        integer NOT NULL CHECK (height > 0),
  bytes         integer NOT NULL CHECK (bytes > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, university_id),
  FOREIGN KEY (owner_id, university_id) REFERENCES memberships (user_id, university_id) ON DELETE CASCADE
);

-- ── Notes and past papers ────────────────────────────────────────────────────
CREATE TABLE study_notes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id text NOT NULL,
  uploader_id   uuid NOT NULL,
  title         text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 100),
  course        text NOT NULL CHECK (char_length(course) BETWEEN 2 AND 60),
  department    text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('notes', 'past_paper', 'assignment', 'other')),
  description   text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  status        text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, university_id),
  FOREIGN KEY (uploader_id, university_id) REFERENCES memberships (user_id, university_id) ON DELETE CASCADE
);
CREATE INDEX study_notes_list_idx ON study_notes (university_id, status, created_at DESC);
CREATE INDEX study_notes_course_idx ON study_notes (university_id, lower(course));

CREATE TABLE note_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id       uuid NOT NULL,
  university_id text NOT NULL,
  storage_key   text NOT NULL,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  mime          text NOT NULL CHECK (mime IN ('application/pdf', 'image/jpeg')),
  bytes         integer NOT NULL CHECK (bytes > 0),
  position      integer NOT NULL DEFAULT 0,
  FOREIGN KEY (note_id, university_id) REFERENCES study_notes (id, university_id) ON DELETE CASCADE
);
CREATE INDEX note_files_note_idx ON note_files (note_id, position);

CREATE TABLE note_votes (
  note_id       uuid NOT NULL,
  university_id text NOT NULL,
  user_id       uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (note_id, user_id),
  FOREIGN KEY (note_id, university_id) REFERENCES study_notes (id, university_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, university_id) REFERENCES memberships (user_id, university_id) ON DELETE CASCADE
);

-- ── Book market ──────────────────────────────────────────────────────────────
CREATE TABLE books (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id text NOT NULL,
  seller_id     uuid NOT NULL,
  title         text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 120),
  author        text NOT NULL DEFAULT '' CHECK (char_length(author) <= 80),
  course        text NOT NULL DEFAULT '' CHECK (char_length(course) <= 60),
  price         integer NOT NULL CHECK (price BETWEEN 0 AND 1000000),
  condition     text NOT NULL CHECK (condition IN ('new', 'like_new', 'good', 'fair')),
  description   text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  status        text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'reserved', 'sold', 'hidden')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, university_id),
  FOREIGN KEY (seller_id, university_id) REFERENCES memberships (user_id, university_id) ON DELETE CASCADE
);
CREATE INDEX books_list_idx ON books (university_id, status, created_at DESC);

CREATE TABLE book_photos (
  book_id       uuid NOT NULL,
  media_id      uuid NOT NULL,
  university_id text NOT NULL,
  position      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (book_id, media_id),
  FOREIGN KEY (book_id, university_id) REFERENCES books (id, university_id) ON DELETE CASCADE,
  FOREIGN KEY (media_id, university_id) REFERENCES media (id, university_id) ON DELETE CASCADE
);

CREATE TABLE book_interest (
  book_id       uuid NOT NULL,
  university_id text NOT NULL,
  user_id       uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (book_id, user_id),
  FOREIGN KEY (book_id, university_id) REFERENCES books (id, university_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, university_id) REFERENCES memberships (user_id, university_id) ON DELETE CASCADE
);

-- ── Study groups ─────────────────────────────────────────────────────────────
CREATE TABLE study_groups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id text NOT NULL,
  created_by    uuid NOT NULL,
  title         text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 80),
  course        text NOT NULL DEFAULT '' CHECK (char_length(course) <= 60),
  description   text NOT NULL DEFAULT '' CHECK (char_length(description) <= 300),
  meeting       text NOT NULL DEFAULT '' CHECK (char_length(meeting) <= 100),
  capacity      integer CHECK (capacity BETWEEN 2 AND 50),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, university_id),
  FOREIGN KEY (created_by, university_id) REFERENCES memberships (user_id, university_id) ON DELETE CASCADE
);
CREATE INDEX study_groups_list_idx ON study_groups (university_id, status, created_at DESC);

CREATE TABLE study_group_members (
  group_id      uuid NOT NULL,
  university_id text NOT NULL,
  user_id       uuid NOT NULL,
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id),
  FOREIGN KEY (group_id, university_id) REFERENCES study_groups (id, university_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, university_id) REFERENCES memberships (user_id, university_id) ON DELETE CASCADE
);

-- ── Jobs and internships (posted by the university's admins) ────────────────
CREATE TABLE jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id text NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  posted_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  company       text NOT NULL CHECK (char_length(company) BETWEEN 2 AND 80),
  title         text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 100),
  kind          text NOT NULL CHECK (kind IN ('job', 'internship', 'part_time')),
  location      text NOT NULL DEFAULT '' CHECK (char_length(location) <= 80),
  description   text NOT NULL DEFAULT '' CHECK (char_length(description) <= 3000),
  apply_url     text CHECK (apply_url ~ '^https://'),
  apply_email   text CHECK (apply_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  deadline      timestamptz,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, university_id),
  CHECK (apply_url IS NOT NULL OR apply_email IS NOT NULL)
);
CREATE INDEX jobs_list_idx ON jobs (university_id, status, created_at DESC);

CREATE TABLE job_saves (
  job_id        uuid NOT NULL,
  university_id text NOT NULL,
  user_id       uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, user_id),
  FOREIGN KEY (job_id, university_id) REFERENCES jobs (id, university_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, university_id) REFERENCES memberships (user_id, university_id) ON DELETE CASCADE
);

-- ── CV profile (the rest of the CV is built from real activity) ──────────────
CREATE TABLE cv_profiles (
  user_id       uuid PRIMARY KEY,
  university_id text NOT NULL,
  summary       text NOT NULL DEFAULT '' CHECK (char_length(summary) <= 600),
  skills        text[] NOT NULL DEFAULT '{}' CHECK (cardinality(skills) <= 15),
  links         text[] NOT NULL DEFAULT '{}' CHECK (cardinality(links) <= 3),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, university_id) REFERENCES memberships (user_id, university_id) ON DELETE CASCADE
);
