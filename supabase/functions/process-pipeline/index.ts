// Supabase Edge Function: process-pipeline
// TTS: Microsoft Edge TTS (free, stable). Qwen backup: docs/backups/tts-qwen-backup.ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { UniversalEdgeTTS } from 'https://esm.sh/edge-tts-universal@1.4.0';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const HF_TOKEN = Deno.env.get('HF_TOKEN')!; // used for FLUX images only

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Helpers ──

async function updateJob(jobId: string, updates: Record<string, unknown>) {
    const { error } = await supabase
        .from('jobs')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', jobId);
    if (error) console.error('Update job error:', error);
}

async function addLog(jobId: string, message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info') {
    const timestamp = new Date().toISOString();
    console.log(`[${type.toUpperCase()}] ${message}`);

    const { data } = await supabase.from('jobs').select('logs').eq('id', jobId).single();
    const logs = data?.logs || [];
    logs.push({ message, type, timestamp });

    await updateJob(jobId, { current_task: message, logs });
}

async function setError(jobId: string, msg: string) {
    await addLog(jobId, msg, 'error');
    await updateJob(jobId, { status: 'error', error_message: msg });
}

async function withRetry<T>(
    fn: () => Promise<T>,
    retries = 5,
    delay = 5000,
    onRetry?: (error: any, attempt: number) => void
): Promise<T> {
    let lastError: any;
    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (i < retries) {
                onRetry?.(err, i + 1);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw lastError;
}

// ── Edge TTS (Microsoft; no API key, stable) ──
const EDGE_TTS_DEFAULT_VOICE = 'en-US-GuyNeural';

function toEdgeVoice(voiceName: string): string {
    if (!voiceName || voiceName.startsWith('ref:')) return EDGE_TTS_DEFAULT_VOICE;
    if (/^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/.test(voiceName)) return voiceName;
    const map: Record<string, string> = {
        'Ryan': 'en-US-GuyNeural',
        'Serena': 'en-US-AriaNeural',
        'Sohee': 'en-US-JennyNeural',
        'en-US-GuyNeural': 'en-US-GuyNeural',
        'en-US-AriaNeural': 'en-US-AriaNeural',
    };
    return map[voiceName] ?? EDGE_TTS_DEFAULT_VOICE;
}

async function edgeTTS(text: string, voiceId: string): Promise<Uint8Array> {
    const voice = toEdgeVoice(voiceId);
    const tts = new UniversalEdgeTTS(text, voice);
    const result = await tts.synthesize();
    const buffer = await result.audio.arrayBuffer();
    return new Uint8Array(buffer);
}

// ── Step 1: Generate JSONs ──
async function generateJsons(jobId: string, script: string, segmentCount: number) {
    await addLog(jobId, 'Breaking script into segments and generating prompts...');
    await updateJob(jobId, { status: 'generating_jsons', progress: 5 });

    const model = 'arcee-ai/trinity-large-preview:free';
    // Voice prompt: RAW text → N spoken paragraphs as JSON; segment_count = number of prompts; each ~50 words
    const voicePrompt = `You are a professional voiceover script editor.

TASK: Split the RAW text into EXACTLY ${segmentCount} segments. Output valid JSON only with keys voice1 to voice${segmentCount}.

CRITICAL — WORD COUNT: Every segment must be 40–60 words (aim for ~50). Count the words. Segments that are only 1–2 sentences or under ~30 words are WRONG and must be expanded. Each segment should take roughly 20–30 seconds to read aloud.

Output format:
{
  "voice1": "first segment text, 40-60 words",
  "voice2": "second segment text, 40-60 words",
  ...
  "voice${segmentCount}": "last segment text, 40-60 words"
}

Rules:

1) Produce EXACTLY ${segmentCount} paragraphs: voice1 → voice${segmentCount}.
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
${script}`;

    try {
        const { cleanVoice, cleanImage } = await withRetry(async () => {
            const voiceRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENROUTER_API_KEY}` },
                body: JSON.stringify({
                    model,
                    messages: [
                        { role: 'system', content: 'You are a professional voiceover script editor. You always output exactly the requested number of segments. Every segment must be 40-60 words; short segments are invalid.' },
                        { role: 'user', content: voicePrompt }
                    ],
                    temperature: 0.7,
                }),
            });
            const voiceData = await voiceRes.json();
            const rawVoice = voiceData.choices?.[0]?.message?.content || '{}';
            const cleanVoice = rawVoice.replace(/```json | ```/g, '').trim();

            // Image prompt: voice JSON → N image prompts (dynamic by segment_count); uses generated voice JSON
            const imagePrompt = `You are an expert visual designer and prompt engineer.

Your task is: Given a JSON of ${segmentCount} text paragraphs (voice1 → voice${segmentCount}), generate a **new JSON with ${segmentCount} image generation prompts** that correspond to each paragraph. Each prompt should describe a **key visual representative frame** for the paragraph.

Requirements:

1. Output must be **valid JSON only**, keys "image1" to "image${segmentCount}", values are strings. No explanations, markdown, instructions, or extra text.
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
${cleanVoice}`;
            const imageRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENROUTER_API_KEY}` },
                body: JSON.stringify({
                    model,
                    messages: [
                        { role: 'system', content: 'You are a storyboard artist.' },
                        { role: 'user', content: imagePrompt }
                    ],
                    temperature: 0.7,
                }),
            });
            const imageData = await imageRes.json();
            const rawImage = imageData.choices?.[0]?.message?.content || '{}';
            const cleanImage = rawImage.replace(/```json | ```/g, '').trim();

            return { cleanVoice, cleanImage };
        }, 5, 5000, (err, count) => addLog(jobId, `Retrying prompt generation(Attempt ${count} / 5)...`, 'warning'));

        await addLog(jobId, 'Prompts successfully generated and validated.', 'success');
        await updateJob(jobId, {
            voice_json: cleanVoice,
            image_json: cleanImage,
            progress: 10,
        });

        return { voiceJson: cleanVoice, imageJson: cleanImage };
    } catch (err) {
        throw new Error(`OpenRouter failed: ${err instanceof Error ? err.message : String(err)} `);
    }
}

const TTS_SEGMENT_DELAY_MS = 800;

// ── Step 2: Generate Voice (Edge TTS) ──
async function generateVoice(jobId: string, voiceJson: string, speaker: string = "Ryan") {
    await updateJob(jobId, { status: 'generating_voice', progress: 35 });
    const voiceLabel = speaker.startsWith('ref:') ? `${EDGE_TTS_DEFAULT_VOICE} (ref not supported)` : toEdgeVoice(speaker);
    await addLog(jobId, `Synthesizing voice using Edge TTS: ${voiceLabel}...`);

    const voices = JSON.parse(voiceJson);
    const voiceKeys = Object.keys(voices);
    const outputFolder = `job_${jobId}`;

    for (let i = 0; i < voiceKeys.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, TTS_SEGMENT_DELAY_MS));

        const text = voices[voiceKeys[i]];
        await addLog(jobId, `Synthesizing voice segment ${i + 1}/${voiceKeys.length}...`);

        try {
            const audioBytes = await withRetry(
                () => edgeTTS(text, speaker),
                3, 3000,
                (err, count) => addLog(jobId, `Retrying segment ${i + 1} (Attempt ${count}/3): ${err instanceof Error ? err.message : String(err)}`, 'warning')
            );

            await supabase.storage
                .from('pipeline_output')
                .upload(`${outputFolder}/audio/voice_${i + 1}.mp3`, audioBytes, {
                    contentType: 'audio/mpeg',
                    upsert: true,
                });

            await addLog(jobId, `Voice segment ${i + 1} finalized and stored.`);
        } catch (err) {
            await addLog(jobId, `Voice segment ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
            await addLog(jobId, i + 1 < voiceKeys.length ? `Skipping segment ${i + 1}; continuing with segment ${i + 2} of ${voiceKeys.length}.` : `Skipping segment ${i + 1}. Voice step done.`, 'warning');
            await updateJob(jobId, { progress: Math.min(35 + Math.floor(((i + 1) / voiceKeys.length) * 5), 39) });
        }
    }

    await addLog(jobId, 'Voice synthesis step complete.', 'success');
    await updateJob(jobId, { progress: 40 });
}

const GITHUB_TOKEN = Deno.env.get('GITHUB_TOKEN');
const GITHUB_REPO = Deno.env.get('GITHUB_REPO') || "DerpFlag/ai_video";

async function triggerStitcher(jobId: string, segmentCount: number) {
    if (!GITHUB_TOKEN) {
        await addLog(jobId, 'GitHub Token missing. Video stitching cannot start automatically.', 'warning');
        return;
    }

    await addLog(jobId, 'Triggering video assembly (GitHub Actions)...');
    try {
        const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/dispatches`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                event_type: 'stitch_video',
                client_payload: {
                    job_id: jobId,
                    segment_count: segmentCount
                }
            })
        });

        if (res.ok) {
            await addLog(jobId, 'Stitcher triggered! Final video will be ready in a few minutes.', 'success');
            await updateJob(jobId, { status: 'stitching', progress: 70 });
        } else {
            const err = await res.text();
            throw new Error(`GitHub API error: ${err}`);
        }
    } catch (err: any) {
        await addLog(jobId, `Stitcher trigger failed: ${err.message}`, 'error');
    }
}

// ── Step 3: Generate Images ──
async function generateImages(jobId: string, imageJson: string) {
    await updateJob(jobId, { status: 'generating_images', progress: 40 });
    await addLog(jobId, 'Generating images with HF FLUX.1 (schnell)...');

    const images = JSON.parse(imageJson);
    const imageKeys = Object.keys(images);
    const outputFolder = `job_${jobId}`;

    for (let i = 0; i < imageKeys.length; i++) {
        const prompt = images[imageKeys[i]];
        await addLog(jobId, `Creating visual frame ${i + 1}/${imageKeys.length}...`);

        try {
            const imgBuffer = await withRetry(async () => {
                const fetchRes = await fetch("https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell", {
                    method: "POST",
                    headers: { "Authorization": `Bearer ${HF_TOKEN}`, "Content-Type": "application/json" },
                    body: JSON.stringify({ inputs: prompt }),
                });

                if (!fetchRes.ok) throw new Error(`HF Status ${fetchRes.status}`);
                return await fetchRes.arrayBuffer();
            }, 5, 5000, (err, count) => addLog(jobId, `Retrying frame ${i + 1} generation... (Attempt ${count}/5)`, 'warning'));

            if (imgBuffer) {
                await supabase.storage
                    .from('pipeline_output')
                    .upload(`${outputFolder}/images/image_${i + 1}.jpg`, new Uint8Array(imgBuffer), {
                        contentType: 'image/jpeg',
                        upsert: true,
                    });

                await updateJob(jobId, { progress: 40 + Math.floor(((i + 1) / imageKeys.length) * 30) });
            } else {
                throw new Error(`HF Image Generation Failed after retries`);
            }
        } catch (err) {
            await addLog(jobId, `Image ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`, 'warning');
        }
    }

    await addLog(jobId, 'Image generation complete.', 'success');
}

// ── Main Handler ──
Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    try {
        const { job_id, script, voice_name, segment_count } = await req.json();

        // 1. Determine the speaker to use
        let finalSpeaker = voice_name || "Ryan";

        // Backward compatibility mapping for Edge TTS names
        if (voice_name === 'en-US-GuyNeural') finalSpeaker = "Ryan";
        else if (voice_name === 'en-US-AriaNeural') finalSpeaker = "Serena";
        else if (voice_name?.includes('Multilingual')) finalSpeaker = "Sohee";

        const segmentCount = Math.min(Math.max(parseInt(String(segment_count), 10) || 5, 1), 60);

        const pipeline = async () => {
            try {
                const { voiceJson, imageJson } = await generateJsons(job_id, script, segmentCount);
                await generateVoice(job_id, voiceJson, finalSpeaker);
                await generateImages(job_id, imageJson);
                await triggerStitcher(job_id, segmentCount);
            } catch (err) {
                await setError(job_id, err instanceof Error ? err.message : String(err));
            }
        };

        (globalThis as any).EdgeRuntime?.waitUntil?.(pipeline());
        if (!(globalThis as any).EdgeRuntime?.waitUntil) await pipeline();

        return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (err) {
        return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
});
