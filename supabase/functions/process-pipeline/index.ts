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

    const { event_id } = await startResponse.json();

    // 2. Poll result from SSE stream
    const dataUrl = `${callUrl}/${event_id}`;
    const resultResponse = await fetch(dataUrl);
    if (!resultResponse.ok) throw new Error("Poll failed");

    const reader = resultResponse.body?.getReader();
    if (!reader) throw new Error("No reader");

    const decoder = new TextDecoder();
    let audioUrl = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');
        for (const line of lines) {
            if (line.startsWith('data:')) {
                const content = line.replace('data:', '').trim();
                try {
                    const parsed = JSON.parse(content);
                    if (Array.isArray(parsed) && parsed[0] && parsed[0].url) {
                        audioUrl = parsed[0].url;
                        break;
                    }
                } catch (e) { /* ignore */ }
            }
        }
        if (audioUrl) break;
    }

    if (!audioUrl) throw new Error(`Audio URL not found in stream for ${endpoint}`);

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
    const voicePrompt = `Rewrite this script into ${segmentCount} natural voiceover segments. Format as valid JSON only: {"voice1": "text", ... , "voice${segmentCount}": "text"}. Rule: 30-50 words per segment. Script: ${script}`;

    try {
        const { cleanVoice, cleanImage } = await withRetry(async () => {
            const voiceRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENROUTER_API_KEY}` },
                body: JSON.stringify({
                    model,
                    messages: [{ role: 'system', content: 'Output valid JSON only.' }, { role: 'user', content: voicePrompt }],
                    temperature: 0.7,
                }),
            });
            const voiceData = await voiceRes.json();
            const rawVoice = voiceData.choices?.[0]?.message?.content || '{}';
            const cleanVoice = rawVoice.replace(/```json|```/g, '').trim();

            const imagePrompt = `Generate ${segmentCount} detailed image prompts mirroring the style of the script. Format: {"image1": "prompt1", ...}. Segments: ${cleanVoice}`;
            const imageRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENROUTER_API_KEY}` },
                body: JSON.stringify({
                    model,
                    messages: [{ role: 'system', content: 'Output valid JSON only.' }, { role: 'user', content: imagePrompt }],
                    temperature: 0.7,
                }),
            });
            const imageData = await imageRes.json();
            const rawImage = imageData.choices?.[0]?.message?.content || '{}';
            const cleanImage = rawImage.replace(/```json|```/g, '').trim();

            return { cleanVoice, cleanImage };
        }, 5, 5000, (err, count) => addLog(jobId, `Retrying prompt generation (Attempt ${count}/5)...`, 'warning'));

        await addLog(jobId, 'Prompts successfully generated and validated.', 'success');
        await updateJob(jobId, {
            voice_json: cleanVoice,
            image_json: cleanImage,
            progress: 10,
        });

        return { voiceJson: cleanVoice, imageJson: cleanImage };
    } catch (err) {
        throw new Error(`OpenRouter failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

// ── Step 2: Generate Voice ──
async function generateVoice(jobId: string, voiceJson: string, speaker: string = "Ryan") {
    await updateJob(jobId, { status: 'generating_voice', progress: 35 });
    await addLog(jobId, `Synthesizing high-quality voice using Qwen-TTS Speaker: ${speaker}...`);

    const voices = JSON.parse(voiceJson);
    const voiceKeys = Object.keys(voices);
    const outputFolder = `job_${jobId}`;

    for (let i = 0; i < voiceKeys.length; i++) {
        const text = voices[voiceKeys[i]];
        await addLog(jobId, `Synthesizing voice segment ${i + 1}/${voiceKeys.length}...`);

        try {
            const audioBytes = await withRetry(
                () => qwenSpaceTTS(text, speaker),
                5, 5000,
                (err, count) => addLog(jobId, `Retrying segment ${i + 1} synthesis... (Attempt ${count}/5)`, 'warning')
            );

            await supabase.storage
                .from('pipeline_output')
                .upload(`${outputFolder}/audio/voice_${i + 1}.mp3`, audioBytes, {
                    contentType: 'audio/mpeg',
                    upsert: true,
                });

            await addLog(jobId, `Voice segment ${i + 1} finalized and stored.`);
        } catch (err) {
            await addLog(jobId, `Voice segment ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`, 'warning');
            await new Promise(r => setTimeout(r, 2000)); // Delay before retry next
        }
    }

    await addLog(jobId, 'Voice synthesis complete.', 'success');
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

        const count = parseInt(segment_count) || 5;

        const pipeline = async () => {
            try {
                const { voiceJson, imageJson } = await generateJsons(job_id, script, count);
                await generateVoice(job_id, voiceJson, finalSpeaker);
                await generateImages(job_id, imageJson);
                await triggerStitcher(job_id, count);
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
