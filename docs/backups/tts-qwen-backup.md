# Qwen TTS Backup — Revert Instructions

This folder holds the **Qwen TTS** (Hugging Face Space) implementation so you can switch back if needed.

- **Code**: `tts-qwen-backup.ts` (full `qwenSpaceTTS` + the `generateVoice` loop that used it, and constants).
- **When to revert**: If you want voice clone again or prefer Qwen voices; Edge TTS has no voice clone.

## How to revert to Qwen TTS

1. Open `supabase/functions/process-pipeline/index.ts`.
2. **Restore the Qwen TTS function**: Replace the Edge TTS block (the `edgeTTS` function and any Edge-only constants) with the contents of `tts-qwen-backup.ts` (the `qwenSpaceTTS` function and the TTS delay/retry constants).
3. **Restore the generateVoice step**: Replace the `generateVoice` implementation with the version in `tts-qwen-backup.ts` (the one that calls `qwenSpaceTTS`, has cooldown for voice clone, and uses `withRetry` with 3 retries).
4. **Restore the webapp voice list**: In `webapp/src/app/page.tsx`, replace `EDGE_TTS_VOICES` (or whatever the Edge list is) with the original `QWEN_VOICES` array and the ref-voice fetch from `voice_clones` / `reference_voices` (see backup in this folder or git history).
5. **Redeploy**: `npx supabase functions deploy process-pipeline`.
6. **Secrets**: Ensure `HF_TOKEN` is set if you use FLUX for images; Qwen Space did not require it for TTS.

## Dependencies when using Qwen

- **Supabase**: `voice_clones` table and `reference_voices` bucket for ref voices.
- **No API key** for the Qwen Space itself (public); optional cooldowns/delays to avoid rate limits.
