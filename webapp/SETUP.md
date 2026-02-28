# AI Video Pipeline — Setup Guide

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

Edit `webapp/.env.local` and fill in your actual keys:

```env
NEXT_PUBLIC_SUPABASE_URL=https://acpxzjrjhvvnwnqzgbxk.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your Supabase anon/public key - find it in Settings > API>
OPENROUTER_API_KEY=<your OpenRouter API key>
FISH_AUDIO_API_KEY=<your Fish Audio API key - get one free at fish.audio>
BYTEZ_API_KEY=9b397141076faeb65abb0717f600537c
```

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
supabase secrets set FISH_AUDIO_API_KEY=<your-key>
supabase secrets set BYTEZ_API_KEY=9b397141076faeb65abb0717f600537c

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
[You in Browser] → [Vercel Frontend]
      ↓                    ↓
      ← polls ←    [Supabase DB] ← updates ←
                           ↓
                [Supabase Edge Function]
                    ↓    ↓    ↓    ↓
              OpenRouter  Fish  Pollinations  Bytez
              (LLM)     (TTS)  (Images)     (Video)
                    ↓    ↓    ↓    ↓
                [Supabase Storage]
```

Everything runs in the cloud. Zero local compute needed.
