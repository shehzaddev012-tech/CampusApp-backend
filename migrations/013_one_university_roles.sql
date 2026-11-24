-- One university per installation, and four roles instead of five.

-- The "department admin" role is merged into "admin".
UPDATE memberships SET role = 'uni_admin' WHERE role = 'dept_admin';
UPDATE posts SET author_role = 'uni_admin' WHERE author_role = 'dept_admin';
ALTER TABLE memberships DROP CONSTRAINT memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK (role IN ('student', 'society_head', 'uni_admin', 'security'));

-- The year of admission is no longer asked for.
ALTER TABLE memberships ALTER COLUMN batch SET DEFAULT '';

-- The profile picture a person uploads themselves (the file lives in storage under avatars/).
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_version bigint NOT NULL DEFAULT 0;
