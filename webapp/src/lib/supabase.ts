import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export type Job = {
  id: string;
  created_at: string;
  script: string;
  voice_name: string;
  segment_count: number;
  status: string;
  progress: number;
  voice_json: string | null;
  image_json: string | null;
  video_json: string | null;
  error_message: string | null;
  output_folder: string | null;
};
