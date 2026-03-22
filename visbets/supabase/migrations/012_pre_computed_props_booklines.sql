-- Add book_lines JSONB column to pre_computed_props
-- This persists per-book lines so they survive Redis TTL expiry.
-- Previously bookLines only existed in Redis, causing empty lines
-- when the Supabase fallback was used.

ALTER TABLE pre_computed_props
  ADD COLUMN IF NOT EXISTS book_lines JSONB DEFAULT '{}'::jsonb;
