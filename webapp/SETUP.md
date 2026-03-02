# AI Video Pipeline — Setup Guide

> **Full project description, APIs, keys, and flow:** see [PROJECT_NOTES.md](../PROJECT_NOTES.md) in the repo root.

## Prerequisites
- Node.js 18+
- Supabase CLI (optional, for deploying edge functions)
- GitHub account (for Vercel deployment)

## Step 1: Set Up Supabase Database

1. Go to your Supabase dashboard: https://supabase.com/dashboard
2. Open your project: `acpxzjrjhvvnwnqzgbxk`
3. Go to **SQL Editor** → **New Query**
4. Copy and paste the contents of `supabase/setup.sql`
5. Click **Run**

## Step 2: Configure Environment Variables

Edit `webapp/.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your Supabase anon key - Settings > API>
```

Edge function secrets (set via Supabase CLI, not in .env): `OPENROUTER_API_KEY`, `HF_TOKEN`, `GITHUB_TOKEN`. See PROJECT_NOTES.md.

## Step 3: Upload Reference Voice

1. In Supabase Dashboard → **Storage**
2. Open the `reference_voices` bucket
3. Upload your voice reference file as `denis.wav` (or whatever voice name you use)

## Step 4: Deploy Edge Function

```bash
# Install Supabase CLI if you haven't
npm install -g supabase

# Login to Supabase
supabase login

# Link your project
supabase link --project-ref acpxzjrjhvvnwnqzgbxk

# Set secrets for the edge function
supabase secrets set OPENROUTER_API_KEY=<your-key>
supabase secrets set HF_TOKEN=<your-huggingface-token>
supabase secrets set GITHUB_TOKEN=<your-github-token>

# Deploy the edge function
supabase functions deploy process-pipeline
```

## Step 5: Run Locally (for testing)

```bash
cd webapp
npm run dev
```

Open http://localhost:3000

## Step 6: Deploy to Vercel

1. Push your code to GitHub
2. Go to https://vercel.com → Import repository
3. Set environment variables in Vercel dashboard
4. Deploy!

## Architecture

```
[Browser] → [Webapp] → [Supabase DB] ← Edge Function (process-pipeline)
                              ↓              ↓     ↓
                        OpenRouter    Qwen TTS   HF FLUX
                        (voice+image   (audio)   (images)
                         prompts)
                              ↓              ↓     ↓
                        [Supabase Storage] ← GitHub Actions (stitcher)
```

See PROJECT_NOTES.md for full flow and API keys.
