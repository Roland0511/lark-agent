ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS display_alias text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'workers_display_alias_valid'
      AND conrelid = 'workers'::regclass
  ) THEN
    ALTER TABLE workers
      ADD CONSTRAINT workers_display_alias_valid CHECK (
        display_alias IS NULL OR (
          display_alias = btrim(display_alias)
          AND char_length(display_alias) BETWEEN 1 AND 64
          AND display_alias !~ '[[:cntrl:]]'
        )
      );
  END IF;
END $$;
