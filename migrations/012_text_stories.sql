-- A story can be only words on a coloured background (no picture), like on WhatsApp.
ALTER TABLE stories ALTER COLUMN media_id DROP NOT NULL;
ALTER TABLE stories ADD COLUMN bg text NOT NULL DEFAULT '';
ALTER TABLE stories DROP CONSTRAINT stories_caption_check;
ALTER TABLE stories ADD CONSTRAINT stories_caption_check CHECK (char_length(caption) <= 280);
ALTER TABLE stories ADD CONSTRAINT stories_has_content CHECK (media_id IS NOT NULL OR char_length(btrim(caption)) > 0);
