// Supabase Edge Function: process-pipeline
// Updated to use Hugging Face Qwen-TTS Space (Gradio 5 API) for synthesis
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { HfInference } from 'https://esm.sh/@huggingface/inference';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const HF_TOKEN = Deno.env.get('HF_TOKEN')!;

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

// ── Qwen TTS Synthesis via Gradio Space ──
async function qwenSpaceTTS(text: string, speakerId: string): Promise<Uint8Array> {
    const isCloning = speakerId.startsWith('ref:');
    const baseUrl = "https://qwen-qwen3-tts.hf.space";
    const endpoint = isCloning ? "generate_voice_clone" : "generate_custom_voice";
    const callUrl = `${baseUrl}/gradio_api/call/${endpoint}`;

    let payloadData: any[] = [];
    if (isCloning) {
        const fileName = speakerId.replace('ref:', '');

        // 1. Fetch transcript from the new voice_clones table
        const { data: cloneData } = await supabase
            .from('voice_clones')
            .select('transcript')
            .eq('file_name', fileName)
            .single();

        const transcript = cloneData?.transcript || "";
        const useXVectorOnly = !transcript; // Only use x-vector if no transcript is available

        // 2. Generate signed URL for the audio file
        const { data: signedData, error: signedError } = await supabase.storage
            .from('reference_voices')
            .createSignedUrl(fileName, 3600);

        if (signedError) throw new Error(`Failed to get signed URL for ${fileName}: ${signedError.message}`);

        payloadData = [
            { path: signedData.signedUrl, meta: { _type: "gradio.FileData" } }, // ref_audio
            transcript,      // ref_text (now dynamic!)
            text,            // target_text
            "Auto",          // language
            useXVectorOnly,  // use_xvector_only (disabled if we have text)
            "1.7B"           // model_size
        ];
    } else {
        payloadData = [
            text,
            "English", // Language
            speakerId, // Speaker name
            "natural and engaging", // Style instruction
            "1.7B"     // Model size
        ];
    }

    // 1. POST to start synthesis
    const startResponse = await fetch(callUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: payloadData })
    });

    if (!startResponse.ok) {
        throw new Error(`Synthesis start failed (${endpoint}): ${await startResponse.text()}`);
    }

    const startJson = await startResponse.json();
    const event_id = startJson?.event_id;
    if (!event_id) throw new Error(`TTS start response missing event_id: ${JSON.stringify(startJson).slice(0, 200)}`);

    // 2. Poll result from SSE stream
    const dataUrl = `${callUrl}/${event_id}`;
    const resultResponse = await fetch(dataUrl);
    if (!resultResponse.ok) {
        const errBody = await resultResponse.text();
        throw new Error(`TTS poll failed (${resultResponse.status}): ${errBody.slice(0, 300)}`);
    }

    const reader = resultResponse.body?.getReader();
    if (!reader) throw new Error("TTS stream: no reader");

    const decoder = new TextDecoder();
    let audioUrl = "";
    let rawStreamText = "";
    let lastEventType = "";
    let onlyNullSeen = true;

    function extractUrl(obj: unknown): string | null {
        if (!obj || typeof obj !== 'object') return null;
        const arr = Array.isArray(obj) ? obj : (obj as Record<string, unknown>).data ?? (obj as Record<string, unknown>).output;
        if (!Array.isArray(arr) || !arr[0]) return null;
        const first = arr[0] as Record<string, unknown>;
        const u = first?.url ?? first?.path;
        if (typeof u === 'string' && (u.startsWith('http://') || u.startsWith('https://'))) return u;
        return null;
    }

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        rawStreamText += chunk;
        const lines = chunk.split('\n');
        for (const line of lines) {
            if (line.startsWith('event:')) {
                lastEventType = line.replace(/^event:\s*/, '').trim();
                continue;
            }
            if (line.startsWith('data:')) {
                const content = line.replace(/^data:\s*/, '').trim();
                if (!content || content === '[DONE]') continue;
                if (content === 'null') {
                    continue;
                }
                try {
                    const parsed = JSON.parse(content);
                    onlyNullSeen = false;
                    if (lastEventType === 'error' && parsed && typeof parsed === 'object') {
                        const errMsg = typeof parsed.message === 'string' ? parsed.message : (parsed.error ?? parsed.msg ?? JSON.stringify(parsed).slice(0, 200));
                        throw new Error(`TTS Space error: ${errMsg}`);
                    }
                    if (parsed && typeof parsed === 'object' && (parsed.error || parsed.msg)) {
                        const errMsg = typeof parsed.error === 'string' ? parsed.error : String(parsed.msg ?? JSON.stringify(parsed).slice(0, 200));
                        throw new Error(`TTS Space error: ${errMsg}`);
                    }
                    const u = extractUrl(parsed);
                    if (u) {
                        audioUrl = u;
                        break;
                    }
                } catch (e) {
                    if (e instanceof Error && e.message.startsWith('TTS Space error:')) throw e;
                }
            }
        }
        if (audioUrl) break;
    }

    if (!audioUrl) {
        const rawTail = rawStreamText.slice(-900).replace(/\n/g, " ");
        if (onlyNullSeen || rawStreamText.includes('"null"') || rawStreamText.trim().endsWith('null')) {
            throw new Error(`TTS Space returned no audio (stream had only null or empty data). The Space may be overloaded—wait longer between segments or retry. Raw tail: ${rawTail}`);
        }
        throw new Error(`Audio URL not found for ${endpoint}. Last event: ${lastEventType || 'none'}. Raw tail: ${rawTail}`);
    }

    // 3. Download the audio file
    const audioRes = await fetch(audioUrl);
    if (!audioRes.ok) throw new Error("Audio download failed");

    const buffer = await audioRes.arrayBuffer();
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

// Delay between TTS requests to avoid Space rate limits / overload (voice clone often fails after 2–3 segments without this)
const TTS_DELAY_MS = 5000;
const TTS_RETRY_DELAY_MS = 10000;

// ── Step 2: Generate Voice ──
async function generateVoice(jobId: string, voiceJson: string, speaker: string = "Ryan") {
    await updateJob(jobId, { status: 'generating_voice', progress: 35 });
    await addLog(jobId, `Synthesizing high-quality voice using Qwen-TTS Speaker: ${speaker}...`);

    const voices = JSON.parse(voiceJson);
    const voiceKeys = Object.keys(voices);
    const outputFolder = `job_${jobId}`;
    const isVoiceClone = speaker.startsWith('ref:');
    const segmentDelayMs = isVoiceClone ? 6000 : TTS_DELAY_MS;

    for (let i = 0; i < voiceKeys.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, segmentDelayMs));

        const text = voices[voiceKeys[i]];
        await addLog(jobId, `Synthesizing voice segment ${i + 1}/${voiceKeys.length}...`);

        let lastErr: Error | null = null;
        try {
            const audioBytes = await withRetry(
                () => qwenSpaceTTS(text, speaker),
                5, TTS_RETRY_DELAY_MS,
                (err, count) => {
                    lastErr = err instanceof Error ? err : new Error(String(err));
                    addLog(jobId, `Retrying segment ${i + 1} (Attempt ${count}/5): ${lastErr.message}`, 'warning');
                }
            );

            await supabase.storage
                .from('pipeline_output')
                .upload(`${outputFolder}/audio/voice_${i + 1}.mp3`, audioBytes, {
                    contentType: 'audio/mpeg',
                    upsert: true,
                });

            await addLog(jobId, `Voice segment ${i + 1} finalized and stored.`);
        } catch (err) {
            lastErr = err instanceof Error ? err : new Error(String(err));
            await addLog(jobId, `Voice segment ${i + 1} failed after retries: ${lastErr.message}`, 'error');
            await addLog(jobId, `Skipping segment ${i + 1} and continuing with remaining segments.`, 'warning');
            await new Promise(r => setTimeout(r, TTS_DELAY_MS));
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
