-- Module 5: points, badges, leaderboards, rewards, lost & found.
-- Same rule as before: rows that belong to a person AND a university reference `memberships (user_id,
-- university_id)`, so leaving a university removes them and a row can never mix two universities.

ALTER TABLE memberships ADD COLUMN leaderboard_visible boolean NOT NULL DEFAULT true;

-- ── Points ───────────────────────────────────────────────────────────────────
-- A balance is never stored: it is the SUM of this ledger. UNIQUE (user, kind, ref) makes every award
-- happen at most once, however many times the action is repeated (leave and join, like and unlike ...).

CREATE TABLE point_ledger (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  university_id text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('event_attend', 'volunteer', 'feedback', 'society_join', 'photo_upload', 'photo_like', 'redeem', 'refund')),
  ref           text NOT NULL,
  points        integer NOT NULL CHECK (points <> 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind, ref),
  CHECK ((kind = 'redeem') = (points < 0)),
  FOREIGN KEY (user_id, university_id) REFERENCES memberships (user_id, university_id) ON DELETE CASCADE
);
CREATE INDEX point_ledger_user_idx ON point_ledger (user_id, created_at DESC);
CREATE INDEX point_ledger_university_idx ON point_ledger (university_id, created_at DESC);

CREATE TABLE user_badges (
  user_id       uuid NOT NULL,
  university_id text NOT NULL,
  badge         text NOT NULL,
  awarded_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, badge),
  FOREIGN KEY (user_id, university_id) REFERENCES memberships (user_id, university_id) ON DELETE CASCADE
);

-- ── Rewards ──────────────────────────────────────────────────────────────────

CREATE TABLE rewards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id text NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  title         text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 80),
  description   text NOT NULL DEFAULT '' CHECK (char_length(description) <= 300),
  cost          integer NOT NULL CHECK (cost BETWEEN 1 AND 100000),
  stock         integer CHECK (stock >= 0),
  active        boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, university_id)
);
CREATE INDEX rewards_university_idx ON rewards (university_id, active);

CREATE TABLE redemptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reward_id     uuid NOT NULL,
  university_id text NOT NULL,
  user_id       uuid NOT NULL,
  cost          integer NOT NULL CHECK (cost > 0),
  code          text NOT NULL UNIQUE,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'collected', 'cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  resolved_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (reward_id, university_id) REFERENCES rewards (id, university_id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id, university_id) REFERENCES memberships (user_id, university_id) ON DELETE CASCADE
);
CREATE INDEX redemptions_user_idx ON redemptions (user_id, created_at DESC);
CREATE INDEX redemptions_open_idx ON redemptions (university_id, status, created_at);

-- ── Lost and found ───────────────────────────────────────────────────────────

CREATE TABLE lost_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id text NOT NULL,
  created_by    uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('lost', 'found')),
  title         text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 80),
  description   text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  place         text NOT NULL DEFAULT '' CHECK (char_length(place) <= 80),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  UNIQUE (id, university_id),
  FOREIGN KEY (created_by, university_id) REFERENCES memberships (user_id, university_id) ON DELETE CASCADE
);
CREATE INDEX lost_items_university_idx ON lost_items (university_id, status, created_at DESC);

-- "This is mine / I found it": one per person per item, so nobody can spam the poster.
CREATE TABLE lost_claims (
  item_id       uuid NOT NULL,
  university_id text NOT NULL,
  user_id       uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, user_id),
  FOREIGN KEY (item_id, university_id) REFERENCES lost_items (id, university_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, university_id) REFERENCES memberships (user_id, university_id) ON DELETE CASCADE
);
