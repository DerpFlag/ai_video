-- Create a table to store metadata for reference voices
CREATE TABLE IF NOT EXISTS public.voice_clones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_name TEXT NOT NULL UNIQUE,  -- matches the file name in 'reference_voices' bucket
    transcript TEXT,                -- the exact text spoken in the reference audio
    display_name TEXT,              -- human-friendly name
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.voice_clones ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read access" ON public.voice_clones FOR SELECT USING (true);

-- Insert current known voices
INSERT INTO public.voice_clones (file_name, display_name, transcript)
VALUES 
('denis.wav', 'Denis', 'Hi, this is derpflag testing voice cloning'),
('anas.wav', 'Anas', '') -- Add more if known
ON CONFLICT (file_name) DO UPDATE 
SET transcript = EXCLUDED.transcript, display_name = EXCLUDED.display_name;
