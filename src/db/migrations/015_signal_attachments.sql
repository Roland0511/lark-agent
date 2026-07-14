ALTER TABLE signals
  ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
