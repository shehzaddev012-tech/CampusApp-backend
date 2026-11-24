-- Module 9: campus stories (a picture and a short line that disappears after 24 hours).
-- Same isolation rule as everywhere else: a story belongs to one membership of one university.

CREATE TABLE stories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id text NOT NULL,
  user_id       uuid NOT NULL,
  media_id      uuid NOT NULL,
  caption       text NOT NULL DEFAULT '' CHECK (char_length(caption) <= 140),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  UNIQUE (id, university_id),
  UNIQUE (media_id),
  FOREIGN KEY (user_id, university_id)  REFERENCES memberships (user_id, university_id) ON DELETE CASCADE,
  FOREIGN KEY (media_id, university_id) REFERENCES media (id, university_id)           ON DELETE CASCADE
);
CREATE INDEX stories_live_idx ON stories (university_id, expires_at DESC);
CREATE INDEX stories_user_idx ON stories (user_id, created_at DESC);

CREATE TABLE story_views (
  story_id      uuid NOT NULL,
  viewer_id     uuid NOT NULL,
  university_id text NOT NULL,
  viewed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id, viewer_id),
  FOREIGN KEY (story_id, university_id)  REFERENCES stories (id, university_id)           ON DELETE CASCADE,
  FOREIGN KEY (viewer_id, university_id) REFERENCES memberships (user_id, university_id) ON DELETE CASCADE
);

-- Stories can be reported like everything else.
ALTER TABLE content_reports DROP CONSTRAINT content_reports_target_type_check;
ALTER TABLE content_reports ADD CONSTRAINT content_reports_target_type_check
  CHECK (target_type IN ('note', 'book', 'study_group', 'job', 'lost_item', 'photo', 'message', 'user', 'story'));
