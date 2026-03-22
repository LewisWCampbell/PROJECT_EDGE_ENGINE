-- Bug Reports table
-- Stores in-app bug reports submitted by users.

CREATE TABLE IF NOT EXISTS bug_reports (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reporter_name TEXT,
  page TEXT NOT NULL,
  description TEXT NOT NULL,
  app_version TEXT,
  platform TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Allow authenticated users to insert bug reports
ALTER TABLE bug_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can insert bug reports"
  ON bug_reports FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Only allow users to read their own reports
CREATE POLICY "Users can read own bug reports"
  ON bug_reports FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Index for admin querying
CREATE INDEX IF NOT EXISTS idx_bug_reports_created_at ON bug_reports(created_at DESC);
