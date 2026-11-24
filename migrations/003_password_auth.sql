-- Email + password sign-in, with one-time codes sent by email.

ALTER TABLE users
  ADD COLUMN password_hash     text,
  ADD COLUMN email_verified_at timestamptz,
  ADD COLUMN failed_logins     integer NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  ADD COLUMN locked_until      timestamptz;

-- Google-created accounts already proved their email.
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;

-- One-time codes. Only a keyed hash of the code is stored, never the code itself.
-- At most ONE unused code per (email, purpose): asking again replaces it.
CREATE TABLE email_otps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL CHECK (email = lower(email)),
  purpose     text NOT NULL CHECK (purpose IN ('signup', 'login', 'reset')),
  code_hash   text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts    integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX email_otps_one_unused ON email_otps (email, purpose) WHERE used_at IS NULL;
CREATE INDEX email_otps_created_idx ON email_otps (created_at);
