-- ============================================================
-- AI Video Pipeline — Database Setup
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================================

-- 1. Create the jobs table
CREATE TABLE IF NOT EXISTS jobs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  
  -- Input
  script TEXT NOT NULL,
  voice_name TEXT NOT NULL DEFAULT 'denis',
  segment_count INTEGER NOT NULL DEFAULT 5,
  
  -- Status tracking
  status TEXT NOT NULL DEFAULT 'pending' 
    CHECK (status IN ('pending', 'generating_jsons', 'generating_voice', 'generating_images', 'generating_videos', 'stitching', 'complete', 'error')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  error_message TEXT,
  
  -- Generated JSON outputs
  voice_json TEXT,
  image_json TEXT,
  video_json TEXT,
  
  -- Output location
  output_folder TEXT
);

-- 2. Auto-update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jobs_updated_at ON jobs;
CREATE TRIGGER jobs_updated_at
  BEFORE UPDATE ON jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- 3. Enable Row Level Security (but allow all for now since it's personal use)
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all operations" ON jobs
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- 4. Create storage buckets
-- Run these via Supabase Dashboard → Storage → New Bucket, or use:
INSERT INTO storage.buckets (id, name, public)
VALUES ('pipeline_output', 'pipeline_output', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public)
VALUES ('reference_voices', 'reference_voices', true)
ON CONFLICT (id) DO NOTHING;

-- 5. Storage policies (allow public read, authenticated write)
CREATE POLICY "Public read pipeline_output" ON storage.objects
  FOR SELECT USING (bucket_id = 'pipeline_output');

CREATE POLICY "Allow upload pipeline_output" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'pipeline_output');

CREATE POLICY "Allow update pipeline_output" ON storage.objects
  FOR UPDATE USING (bucket_id = 'pipeline_output');

CREATE POLICY "Public read reference_voices" ON storage.objects
  FOR SELECT USING (bucket_id = 'reference_voices');
