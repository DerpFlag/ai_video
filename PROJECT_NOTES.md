# AI Video Pipeline — Project Notes

This document describes what we're building, how it works, which APIs and keys are used, and how the webapp and pipeline interact. **Keep this file updated when making major changes to the project.**

---

## Supabase Project

| | |
|--|--|
| **Project name** | ai-video-pipeline |
| **Project ID** | `acpxzjrjhvvnwnqzgbxk` |
| **Project URL** | `https://acpxzjrjhvvnwnqzgbxk.supabase.co` |

---

## Keys and API values (sensitive — do not commit to public repos)

### Supabase (project `acpxzjrjhvvnwnqzgbxk`)

| Key | Value | Use |
|-----|--------|-----|
| **Project URL** | `https://acpxzjrjhvvnwnqzgbxk.supabase.co` | Webapp + Edge Function + stitcher |
| **Publishable key** | Set in Dashboard → API | Webapp: `NEXT_PUBLIC_SUPABASE_ANON_KEY` (optional alternate to anon JWT) |
| **Secret key** | Set in Dashboard → API (do not commit) | Backend / server-only use |
| **Anon (public) JWT** | Set in Dashboard → API | Webapp: `NEXT_PUBLIC_SUPABASE_ANON_KEY` (standard) |
| **Service role JWT** | Set in Dashboard → API | Edge Function + GitHub Actions: `SUPABASE_SERVICE_ROLE_KEY` (Supabase injects when deployed) |

Store actual values in `webapp/.env.local` (gitignored) and in Supabase/GitHub secrets. Do not commit real keys.

**Webapp env**: `webapp/.env.local` (gitignored) should set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` so the app can create jobs and trigger the edge function. Run `npm run dev` in `webapp/` and open http://localhost:3000 to verify.

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
| **Segment count** | The **count** control in the webapp (e.g. 5, 10, 30). Sent as `segment_count`; clamped to 1–60 in the edge function. Drives how many voice/image segments are generated. |

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

- **Segment count (webapp)**: The “Segments” control is how many prompts you want in the JSON (voice1…voiceN and image1…imageN). N = segment count (1–60).
- **Voice prompt**: Asks the LLM for **exactly N** paragraphs (`voice1` … `voiceN`). **Each paragraph must be 40–60 words** (~50); the prompt and system message stress this so TTS segments are ~20–30 seconds of speech, not 2 seconds. TTS-friendly, output only valid JSON. Placeholder: raw script.
- **Image prompt**: Input is the **generated voice JSON**. Asks for **exactly N** image prompts (`image1` … `imageN`), consistent style, rich visual details, output only valid JSON.

Both N values are the same and come from the user’s **segment count** (clamped 1–60).

---

## Voice prompt (full text)

Used to generate the voice JSON from raw script. At runtime `{segmentCount}` is replaced with the user’s segment count (1–60) and `{script}` with the raw script.

**System message:**  
`You are a professional voiceover script editor. You always output exactly the requested number of segments. Every segment must be 40-60 words; short segments are invalid.`

**User prompt:**

```
You are a professional voiceover script editor.

TASK: Split the RAW text into EXACTLY {segmentCount} segments. Output valid JSON only with keys voice1 to voice{segmentCount}.

CRITICAL — WORD COUNT: Every segment must be 40–60 words (aim for ~50). Count the words. Segments that are only 1–2 sentences or under ~30 words are WRONG and must be expanded. Each segment should take roughly 20–30 seconds to read aloud.

Output format:
{
  "voice1": "first segment text, 40-60 words",
  "voice2": "second segment text, 40-60 words",
  ...
  "voice{segmentCount}": "last segment text, 40-60 words"
}

Rules:

1) Produce EXACTLY {segmentCount} paragraphs: voice1 → voice{segmentCount}.
   Each paragraph MUST be 40–60 words. Do not output short 1–2 sentence chunks.
   Maintain logical and narrative flow across segments.

2) Rewrite for speech:
   - Use conversational language
   - Prefer short, clear sentences
   - Improve rhythm and pacing
   - Use natural transitions
   - Remove awkward phrasing
   - Preserve meaning and key facts

3) Optimize for text-to-speech:
   - Avoid long or nested sentences
   - Avoid symbols, lists, and formatting
   - Avoid uncommon abbreviations
   - Spell out numbers when helpful
   - Use punctuation to guide pauses

4) Do NOT include:
   - Inline performance instructions
   - Stage directions
   - Bracketed emotion tags
   - Markup or metadata
   - Explanations
   - Markdown
   - Extra text

5) Output ONLY valid JSON.
   No comments. No trailing commas. No text outside JSON.

RAW TEXT:
{script}
```

---

## Image prompt (full text)

Used to generate the image JSON from the voice JSON. At runtime `{segmentCount}` is replaced with the same segment count and `{voiceJson}` with the **generated voice JSON** (output of the voice step).

**System message:**  
`You are a storyboard artist.`

**User prompt:**

```
You are an expert visual designer and prompt engineer.

Your task is: Given a JSON of {segmentCount} text paragraphs (voice1 → voice{segmentCount}), generate a **new JSON with {segmentCount} image generation prompts** that correspond to each paragraph. Each prompt should describe a **key visual representative frame** for the paragraph.

Requirements:

1. Output must be **valid JSON only**, keys "image1" to "image{segmentCount}", values are strings. No explanations, markdown, instructions, or extra text.
2. Each prompt should describe a **single, clear image** representing the paragraph.
3. Maintain a **consistent visual style** across all prompts:
   - Color palette (e.g., cinematic, moody, vibrant, pastel)
   - Character design (age, gender, clothing, expression)
   - Background style (interior, exterior, lighting, weather)
4. Include **rich visual details**:
   - Lighting (soft, harsh, golden hour, neon, shadows)
   - Composition (foreground, background, perspective)
   - Objects and environment
   - Emotions conveyed by scene
5. The prompt should be concise but descriptive enough to generate a **high-quality, static first frame** for a video.
6. Do NOT include explanations, instructions, markdown, or extra text.

Example format:
{
  "image1": "A young woman standing on a rainy street under neon lights, reflective puddles, cinematic moody palette, detailed skyscraper background, soft rain, contemplative expression, key visual representative frame",
  "image2": "..."
}

Input JSON:
{voiceJson}
```

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

## Fixes / behaviour notes

- **Stitcher**: If an MP3 fails ffprobe (e.g. truncated/corrupt from TTS), the script no longer crashes. It uses a default duration for that segment and skips that file in the audio concat, so the job can still complete (video with fewer or no audio segments if all fail). Critical failure messages are truncated to one line (~500 chars) in the job log.
- **Webapp**: When a job is in `error` status, `error_message` is shown in the same "Live Execution Logs" list as a final log line (same styling). Long messages use `.log-error-block` (pre-wrap, word-break) so layout stays consistent.
- **Edge function**: `outputFolder` for voice uploads is `job_<id>` with no trailing space so stitcher paths match.
- **TTS (Qwen Space)**:
  - **Delay between segments**: 2.5s pause before each new segment to reduce Space rate limits / overload (fixes "Audio URL not found" after a few segments).
  - **Retries**: 5 attempts, 8s between attempts; each retry logs the **actual error** (e.g. "Retrying segment 3 (Attempt 2/5): Audio URL not found in stream... Stream tail: ...").
  - **Stream errors**: If the Space returns an error in the SSE stream (`error` or `msg`), we throw with that message. If no URL is found, we throw with the last few stream lines so you can see what the Space returned.
  - **Failed segments**: If a segment still fails after all retries, we log "Voice segment X failed after retries: <full error>" (as error), then "Skipping segment X and continuing with remaining segments." and continue. Pipeline does not stop; stitcher will use whatever audio was produced.
  - **Voice clones & `voice_clones` table**: When you use a ref voice (e.g. `ref:denis.wav`), we **do** use the **voice_clones** table. We look up the row by `file_name` (e.g. `denis.wav`) and read **transcript**. If **transcript** is set, we send it to the Qwen Space as **ref_text** and set **use_xvector_only = false**, so the model uses both the reference audio and the known spoken text for better cloning. If transcript is missing/empty, we use **use_xvector_only = true** (voice embedding only). So adding a transcript in `voice_clones` for your reference file improves clone quality when available.
  - **Why the 3rd voice segment fails (`event: error data: null`)**: The Qwen TTS Space (voice clone) often **errors on the 3rd request** in a row—it returns `event: error data: null` (rate limit or internal overload). So segment 1 and 2 succeed, segment 3 fails. Fixes: (1) **22s cooldown** before segment 3, 5, 7, … when using voice clone, so the Space has time to reset. (2) **7s** between every voice-clone segment. (3) On **`event: error` + `data: null`** we throw immediately with a clear message and **retry only 3 times** (8s apart) so we don’t burn time and hit the Edge Function timeout; then we **skip** that segment and **continue** to the next (we log "Skipping segment X; continuing with segment X+1" and bump progress so the UI doesn’t look stuck). (4) Pipeline never stops by design—if segment 3 fails after retries, we do segment 4 and 5. If the task stays on "generating_voice" with no new logs, the Edge Function likely **timed out** (e.g. too many retries before the fix). **Test script**: `node scripts/test-qwen-tts-stream.mjs 3`.

---

## Deploy / Update Checklist

1. **Supabase** (project linked as `acpxzjrjhvvnwnqzgbxk`):
   - From repo root: `npx supabase functions deploy process-pipeline` (no global install; uses npx).
   - Ensure secrets are set: `npx supabase secrets set OPENROUTER_API_KEY=...` etc.
2. **GitHub**: Push code; ensure repo secrets are set for the stitcher workflow.
3. **Webapp**: Deploy (e.g. Vercel) with `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (use Dashboard → API for anon/publishable key).

---

## DB Schema (jobs)

- `id`, `created_at`, `updated_at`
- `script`, `voice_name`, `segment_count`
- `status` (pending | generating_jsons | generating_voice | generating_images | stitching | complete | error)
- `progress` (0–100), `error_message`, `current_task`, `logs`
- `voice_json`, `image_json`
- `output_folder` (e.g. `job_<uuid>` in `pipeline_output` bucket)

Storage: `pipeline_output/job_<id>/audio/voice_1.mp3` … and `images/image_1.jpg` …; final video in same folder (or as documented in stitcher).
