ALTER TABLE chat_thread_snapshot_turns
  ADD COLUMN IF NOT EXISTS summary text,
  ADD COLUMN IF NOT EXISTS summary_source text,
  ADD COLUMN IF NOT EXISTS summary_model text,
  ADD COLUMN IF NOT EXISTS summary_generated_at timestamptz;

ALTER TABLE chat_thread_snapshot_turns
  DROP CONSTRAINT IF EXISTS chat_thread_snapshot_turns_summary_length_check,
  ADD CONSTRAINT chat_thread_snapshot_turns_summary_length_check
    CHECK (summary IS NULL OR char_length(btrim(summary)) BETWEEN 1 AND 24),
  DROP CONSTRAINT IF EXISTS chat_thread_snapshot_turns_summary_source_check,
  ADD CONSTRAINT chat_thread_snapshot_turns_summary_source_check
    CHECK (summary_source IS NULL OR summary_source IN ('ai', 'fallback')),
  DROP CONSTRAINT IF EXISTS chat_thread_snapshot_turns_summary_consistency_check,
  ADD CONSTRAINT chat_thread_snapshot_turns_summary_consistency_check
    CHECK (
      (summary IS NULL AND summary_source IS NULL AND summary_model IS NULL AND summary_generated_at IS NULL)
      OR (summary IS NOT NULL AND summary_source IS NOT NULL AND summary_generated_at IS NOT NULL)
    );

CREATE INDEX IF NOT EXISTS chat_thread_snapshot_turns_ai_summary_page_idx
  ON chat_thread_snapshot_turns(job_id, turn_index DESC)
  WHERE summary_source = 'ai';
