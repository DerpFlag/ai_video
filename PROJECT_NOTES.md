# AI Video Pipeline — Project Notes

This document describes what we're building, how it works, which APIs and keys are used, and how the webapp and pipeline interact.

---

## What We're Building

An **AI-powered video pipeline** that turns a **raw script** into a **finished video**:

1. **Script** → split into N segments and rewritten for natural speech (LLM).
2. **Voice JSON** → each segment is synthesized to audio (TTS).
3. **Image JSON** → each segment gets a visual prompt; images are generated (image model).
4. **Audio + images** → combined into a single video (stitcher: GitHub Actions or Render).

The user picks **segment count** (e.g. 5 or 30). Prompts (voice and image) are **dynamic** and depend on this number.

---

## High-Level Flow

```
[Webapp] User enters: script, voice name, segment count
    ↓
[Webapp API] POST /api/submit → creates job in Supabase, triggers Edge Function
    ↓
[Supabase Edge Function: process-pipeline]
    1. generateJsons(script, segment_count)
         → OpenRouter (LLM): raw script → voice1..voiceN JSON
         → OpenRouter (LLM): voice JSON → image1..imageN JSON
    2. generateVoice(voiceJson) → Qwen TTS (Hugging Face Space) → MP3s to Storage
    3. generateImages(imageJson) → Hugging Face FLUX.1-schnell → JPGs to Storage
    4. triggerStitcher(job_id, segment_count) → GitHub repository_dispatch
    ↓
[GitHub Actions] Runs stitcher/script.js
    → Downloads audio + images from Supabase Storage
    → FFmpeg: concat + mix → final video
    → Uploads video to Storage, updates job status to complete
    ↓
[Webapp] Polls job status; user sees progress, logs, and final video link
```

---

## User Inputs (Webapp)

| Input | Description |
|-------|-------------|
| **Script** | Raw text (article, story, etc.). No fixed length. |
| **Voice** | Built-in Qwen voices (Ryan, Serena, Sohee, …) or **Clone: &lt;name&gt;** (custom voice from `reference_voices` bucket + `voice_clones` table). |
| **Segment count** | Number of segments (e.g. 5, 10, 30). Clamped to 1–60 in the edge function. Drives how many voice/image segments are generated. |

---

## What the User Gets

- **Job list** with status, progress %, segment count, and time ago.
- **Per-job view**: status steps (Queued → Scripts → Voices → Images → Video → Success), live logs, error message if failed.
- **Final video** when status is `complete`: link to the file in Supabase Storage (`output_folder` + video file).

---

## APIs and Accounts

### 1. Supabase

- **Usage**: Database (`jobs`, `voice_clones`), Storage (`pipeline_output`, `reference_voices`), Edge Functions.
- **Keys**:
  - **Project URL** — `SUPABASE_URL` (edge function env) / `NEXT_PUBLIC_SUPABASE_URL` (webapp).
  - **Anon key** — `NEXT_PUBLIC_SUPABASE_ANON_KEY` (webapp; used to call edge function and read DB/storage).
  - **Service role key** — `SUPABASE_SERVICE_ROLE_KEY` (edge function, GitHub Actions stitcher; full access).
- **Where**: Supabase Dashboard → Project Settings → API.

### 2. OpenRouter

- **Usage**: LLM for (1) script → voice JSON, (2) voice JSON → image prompts JSON.
- **Model**: `arcee-ai/trinity-large-preview:free`.
- **Key**: `OPENROUTER_API_KEY` — set as **Supabase Edge Function secret** (not in webapp).
- **Account**: https://openrouter.ai (API keys).

### 3. Hugging Face

- **Qwen TTS**: Hosted Space `qwen-qwen3-tts.hf.space` (Gradio API). No key required for the Space itself; optional for gated models.
- **FLUX.1-schnell**: Image generation via `router.huggingface.co` (or HF Inference API).
- **Key**: `HF_TOKEN` — set as **Supabase Edge Function secret** (used for image generation).
- **Account**: https://huggingface.co (Settings → Access Tokens).

### 4. GitHub

- **Usage**: Repository dispatch to run the stitcher workflow (`.github/workflows/stitcher.yml`); workflow runs `stitcher/script.js`.
- **Secrets** (repo): `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, and optionally `MINIMAX_API_KEY` / `MINIMAX_TASKS_JSON` if you add Minimax later.
- **Token**: `GITHUB_TOKEN` — set as **Supabase Edge Function secret**; must have `repo` scope to trigger `repository_dispatch`. Can be a Personal Access Token or GitHub App token.
- **Repo**: Configurable via env `GITHUB_REPO` (default in code: `DerpFlag/ai_video`).

---

## Environment Variables Summary

### Webapp (e.g. `.env.local` or Vercel)

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anon/public key |

### Supabase Edge Function (process-pipeline) — set via `supabase secrets set`

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key |
| `HF_TOKEN` | Yes | Hugging Face token (for FLUX image generation) |
| `GITHUB_TOKEN` | No* | Token to trigger GitHub Actions (*required for automatic stitching) |
| `GITHUB_REPO` | No | e.g. `owner/repo` (default in code: `DerpFlag/ai_video`) |

Supabase injects `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` automatically.

### GitHub Actions (stitcher workflow)

Secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`. Optional: `MINIMAX_API_KEY`, `MINIMAX_TASKS_JSON`.

---

## Prompts (Dynamic by segment_count)

- **Voice prompt**: Asks the LLM for **exactly N** paragraphs (`voice1` … `voiceN`), 40–60 words each, TTS-friendly, output only valid JSON. Placeholder: raw script.
- **Image prompt**: Input is the **generated voice JSON**. Asks for **exactly N** image prompts (`image1` … `imageN`), consistent style, rich visual details, output only valid JSON.

Both N values are the same and come from the user’s **segment count** (clamped 1–60).

---

## Repo Layout (relevant parts)

- **webapp/** — Next.js app: submit form, job list, status polling, logs.
- **webapp/src/app/api/submit/route.ts** — Creates job, calls edge function.
- **webapp/src/app/api/status/route.ts** — (if used) job status API.
- **webapp/src/lib/supabase.ts** — Supabase client and `Job` type.
- **supabase/functions/process-pipeline/index.ts** — Main pipeline (LLM → TTS → images → trigger stitcher).
- **supabase/setup.sql** — `jobs` table and storage buckets.
- **supabase/setup_voice_clones.sql** — `voice_clones` table for custom voice metadata.
- **.github/workflows/stitcher.yml** — Runs `stitcher/script.js` with `JOB_ID`, `SEGMENT_COUNT`.
- **stitcher/script.js** — Downloads assets from Supabase, FFmpeg stitch, uploads video, updates job.
- **n8n.json** — Alternative n8n workflow (voice + image prompts; can mirror edge function logic).

---

## Deploy / Update Checklist

1. **Supabase**: Deploy edge function: `supabase functions deploy process-pipeline`. Set secrets as above.
2. **GitHub**: Push code; ensure repo secrets are set for the stitcher workflow.
3. **Webapp**: Deploy (e.g. Vercel) with `NEXT_PUBLIC_SUPABASE_*` env vars.

---

## DB Schema (jobs)

- `id`, `created_at`, `updated_at`
- `script`, `voice_name`, `segment_count`
- `status` (pending | generating_jsons | generating_voice | generating_images | stitching | complete | error)
- `progress` (0–100), `error_message`, `current_task`, `logs`
- `voice_json`, `image_json`
- `output_folder` (e.g. `job_<uuid>` in `pipeline_output` bucket)

Storage: `pipeline_output/job_<id>/audio/voice_1.mp3` … and `images/image_1.jpg` …; final video in same folder (or as documented in stitcher).
