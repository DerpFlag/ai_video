// Supabase Edge Function: process-pipeline
// This runs entirely in the cloud (Deno runtime on Supabase Edge)
// It orchestrates the full AI video pipeline:
//   1. Generate voice/image/video JSON prompts via OpenRouter
//   2. Generate voiceovers via Fish Audio TTS
//   3. Generate images via Pollinations.ai (free, no key)
//   4. Generate videos via Bytez API (Wan2.1)
//   5. Upload all assets to Supabase Storage
//   6. Trigger stitcher service to concat videos, mix audio, speed-adjust

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { HfInference } from 'https://esm.sh/@huggingface/inference';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FISH_AUDIO_API_KEY = Deno.env.get('FISH_AUDIO_API_KEY') || '';
const BYTEZ_API_KEY = Deno.env.get('BYTEZ_API_KEY') || '';
const HF_TOKEN = Deno.env.get('HF_TOKEN') || ''; // Must be set in Supabase Secrets
const GITHUB_REPO = Deno.env.get('GITHUB_REPO') || '';   // e.g., "username/ai_video"
const GITHUB_TOKEN = Deno.env.get('GITHUB_TOKEN') || ''; // Personal Access Token
const MINIMAX_API_KEY = Deno.env.get('MINIMAX_API_KEY') || "sk-api-vGMXoH6OWRk1a-yl9obMpsns8L23lhyC7EIl23NseM7Uv8fTA6BGqqBnx_ofWHRohLGmaAHCaxg8iNESnbG0q-K418Ofvelz3j2ocmBBhIMsN_iM_o2zjOQ";
const MINIMAX_GROUP_ID = "2024897099987956064";
const MINIMAX_MODEL = "MiniMax-Hailuo-02";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Helpers ──
async function updateJob(jobId: string, updates: Record<string, unknown>) {
    const { error } = await supabase
        .from('jobs')
        .update(updates)
        .eq('id', jobId);
    if (error) console.error('Update job error:', error);
}

async function setError(jobId: string, msg: string) {
    await updateJob(jobId, { status: 'error', error_message: msg });
}

// ── Step 1: Generate JSONs via OpenRouter ──
async function generateJsons(jobId: string, script: string, segmentCount: number) {
    await updateJob(jobId, { status: 'generating_jsons', progress: 5 });

    const model = 'arcee-ai/trinity-large-preview:free';    // Voice JSON
    const voicePrompt = `You are a professional voiceover script editor.

Convert the RAW text into a clear, natural, spoken script formatted as valid JSON only.

Output format:
{
  "voice1": "text",
  "voice2": "text",
  ...
  "voice${segmentCount}": "text"
}

Rules:

1) Produce EXACTLY ${segmentCount} paragraphs: voice1 → voice${segmentCount}.
   Each paragraph must be 40–60 words.
   Maintain logical and narrative flow.

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

    const voiceRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: 'You are a professional voiceover script editor. Output only valid JSON.' },
                { role: 'user', content: voicePrompt }
            ],
            max_tokens: 4000,
            temperature: 0.7,
        }),
    });
    const voiceData = await voiceRes.json();
    const rawVoice = voiceData.choices?.[0]?.message?.content || '{}';

    await updateJob(jobId, { progress: 15 });

    // Image JSON
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
${rawVoice}`;

    const imageRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: 'You are a storyboard artist. Output only valid JSON.' },
                { role: 'user', content: imagePrompt }
            ],
            max_tokens: 4000,
            temperature: 0.7,
        }),
    });
    const imageData = await imageRes.json();
    const rawImage = imageData.choices?.[0]?.message?.content || '{}';

    await updateJob(jobId, { progress: 25 });

    // Video JSON
    const videoPrompt = `You are an expert cinematic director and visual prompt engineer.

Your task is: Given a JSON of ${segmentCount} text paragraphs (image1 → image${segmentCount}), generate a **new JSON with ${segmentCount} video generation prompts**, one per paragraph. Each prompt should describe a **20-second dynamic video** corresponding to the paragraph.

Requirements:

1. Output must be **valid JSON only**, keys "video1" to "video${segmentCount}", values are strings. No explanations, markdown, instructions, or extra text.
2. Each prompt should describe a **multi-shot / multi-action scene** suitable for a 20-second clip.
3. Maintain a **consistent visual style** across all prompts:
   - Color palette
   - Character design
   - Background environment
   - Lighting
4. Include **types of cinematic shots and camera angles** (use creatively):
   - Eye Level Shot
   - Low Angle Shot
   - High Angle Shot
   - Hip Level Shot
   - Knee Level Shot
   - Ground Level Shot
   - Shoulder Level Shot
   - Dutch Angle
   - Bird’s-Eye View
   - Aerial Shot
   - Over-the-Shoulder Shot
   - Tracking Shot
   - Close-Up
   - Extreme Close-Up
5. Include **motion/action cues**:
   - Camera movement (pan, tilt, dolly, tracking)
   - Character motion (walking, running, turning, gesturing)
   - Environmental motion (rain, smoke, fire, explosions)
6. Include **rich visual details**:
   - Foreground and background composition
   - Textures, objects, and props
   - Emotions conveyed by scene
7. Each prompt should **flow through multiple micro-scenes** (e.g., opening establishing shot, mid-action close-up, end wide shot) to make the video visually dynamic.
8. Do NOT include explanations, markdown, instructions, or extra text.

Example format:
{
  "video1": "Eye level shot: young woman walks down neon-lit rainy street, camera slowly dollying forward; Close-up: raindrops on her cheek, contemplative expression; Tracking shot: pan to distant skyscrapers, mist rising; Wide shot: entire street, moving cars, neon reflections, cinematic moody palette",
  "video2": "High angle shot: bustling market, camera tilting down to show interactions; Medium shot: vendor gestures, colorful produce; Close-up: hand exchanging coin; Wide shot: crowd moves through street, cinematic lighting"
}

Input JSON:
${rawImage}`;

    const videoRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: 'You are a cinematic director. Output only valid JSON.' },
                { role: 'user', content: videoPrompt }
            ],
            max_tokens: 4000,
            temperature: 0.7,
        }),
    });
    const videoData = await videoRes.json();
    const rawVideo = videoData.choices?.[0]?.message?.content || '{}';

    // Clean and parse JSONs
    const cleanJson = (raw: string) => {
        try {
            const clean = raw.replace(/```json|```/g, '').trim();
            const obj = JSON.parse(clean);
            return JSON.stringify(obj);
        } catch {
            return '{}';
        }
    };

    const voiceJson = cleanJson(rawVoice);
    const imageJson = cleanJson(rawImage);
    const videoJson = cleanJson(rawVideo);

    await updateJob(jobId, {
        voice_json: voiceJson,
        image_json: imageJson,
        video_json: videoJson,
        progress: 30,
    });

    return { voiceJson, imageJson, videoJson };
}

// ── Step 2: Generate Voice via Fish Audio ──
async function generateVoice(jobId: string, voiceJson: string, voiceName: string) {
    await updateJob(jobId, { status: 'generating_voice', progress: 35 });

    const voices = JSON.parse(voiceJson);
    const voiceKeys = Object.keys(voices);
    const outputFolder = `job_${jobId}`;

    // Get the reference voice URL from Supabase Storage
    const refVoiceUrl = `${SUPABASE_URL}/storage/v1/object/public/reference_voices/${voiceName}.wav`;

    for (let i = 0; i < voiceKeys.length; i++) {
        const text = voices[voiceKeys[i]];
        const progress = 35 + Math.round((i / voiceKeys.length) * 15);
        await updateJob(jobId, { progress });

        try {
            if (FISH_AUDIO_API_KEY) {
                // Use Fish Audio TTS with voice cloning
                const ttsRes = await fetch('https://api.fish.audio/v1/tts', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${FISH_AUDIO_API_KEY}`,
                    },
                    body: JSON.stringify({
                        text,
                        reference_id: voiceName, // Uses the voice model ID on Fish Audio
                        format: 'mp3',
                    }),
                });

                if (ttsRes.ok) {
                    const audioBuffer = await ttsRes.arrayBuffer();
                    const audioBytes = new Uint8Array(audioBuffer);

                    // Upload to Supabase Storage
                    await supabase.storage
                        .from('pipeline_output')
                        .upload(`${outputFolder}/audio/voice_${i + 1}.mp3`, audioBytes, {
                            contentType: 'audio/mpeg',
                            upsert: true,
                        });
                } else {
                    console.error(`Fish Audio TTS failed for segment ${i + 1}:`, await ttsRes.text());
                }
            } else {
                console.log(`No Fish Audio key, skipping TTS for segment ${i + 1}`);
            }
        } catch (err) {
            console.error(`Voice generation error for segment ${i + 1}:`, err);
        }
    }

    await updateJob(jobId, { progress: 50 });
}

// ── Step 3: Generate Images via HuggingFace (FLUX.1-schnell) ──
async function generateImages(jobId: string, imageJson: string) {
    await updateJob(jobId, { status: 'generating_images', progress: 50 });

    const images = JSON.parse(imageJson);
    const imageKeys = Object.keys(images);
    const outputFolder = `job_${jobId}`;

    // Initialize HuggingFace client
    const hf = new HfInference(HF_TOKEN || "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");

    for (let i = 0; i < imageKeys.length; i++) {
        const prompt = images[imageKeys[i]];
        const progress = 50 + Math.round((i / imageKeys.length) * 20);
        await updateJob(jobId, { progress });

        try {
            console.log(`[Job ${jobId}] Generating image ${i + 1} with HF FLUX...`);

            // Standard HF Fetch method to bypass provider nscale proxy routing errors
            const fetchRes = await fetch("https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${HF_TOKEN || "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"}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ inputs: prompt }),
            });

            if (fetchRes.ok) {
                const imgBuffer = await fetchRes.arrayBuffer();
                const imgBytes = new Uint8Array(imgBuffer);

                // Upload to Supabase Storage
                await supabase.storage
                    .from('pipeline_output')
                    .upload(`${outputFolder}/images/image_${i + 1}.jpg`, imgBytes, {
                        contentType: 'image/jpeg',
                        upsert: true,
                    });
                console.log(`[Job ${jobId}] Image ${i + 1} uploaded successfully.`);
            } else {
                console.error(`Image gen failed for segment ${i + 1}: ${fetchRes.status} -`, await fetchRes.text());
            }
        } catch (err) {
            console.error(`Image generation error for segment ${i + 1}:`, err);
        }
    }

    await updateJob(jobId, { progress: 70 });
}

// ── Step 4: Generate Videos via MiniMax (Hailuo-02) ──
async function generateVideos(jobId: string, videoJson: string) {
    await updateJob(jobId, { status: 'generating_videos', progress: 70 });

    const videos = JSON.parse(videoJson);
    const videoKeys = Object.keys(videos);
    const outputFolder = `job_${jobId}`;
    const minimaxTasks: string[] = [];

    for (let i = 0; i < videoKeys.length; i++) {
        const prompt = videos[videoKeys[i]];
        const progress = 70 + Math.round((i / videoKeys.length) * 20);
        await updateJob(jobId, { progress });

        try {
            // First frame public URL for MiniMax
            const firstFrameUrl = `${SUPABASE_URL}/storage/v1/object/public/pipeline_output/${outputFolder}/images/image_${i + 1}.jpg`;

            console.log(`[Job ${jobId}] Submitting video ${i + 1} to MiniMax...`);
            const payload = {
                prompt: prompt.substring(0, 2000),
                model: MINIMAX_MODEL,
                duration: 6, // 6 seconds like Colab format
                resolution: "720P",
                first_frame_image: firstFrameUrl
            };

            const vRes = await fetch('https://api.minimax.io/v1/video_generation', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${MINIMAX_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            if (vRes.ok) {
                const vData = await vRes.json();
                if (vData.task_id) {
                    minimaxTasks.push(vData.task_id);
                    console.log(`[Job ${jobId}] MiniMax task submitted: ${vData.task_id}`);
                } else {
                    console.error("No task_id from MiniMax:", vData);
                    minimaxTasks.push("");
                }
            } else {
                console.error(`MiniMax API failed for segment ${i + 1}:`, await vRes.text());
                minimaxTasks.push("");
            }

        } catch (err) {
            console.error(`Video generation error for segment ${i + 1}:`, err);
            minimaxTasks.push("");
        }
    }

    await updateJob(jobId, { progress: 90 });
    return minimaxTasks;
}

// ── Step 5: Trigger Stitcher Service (GitHub Actions) ──
async function triggerStitcher(jobId: string, segmentCount: number, minimaxTasks: string[]) {
    await updateJob(jobId, { status: 'stitching', progress: 92 });

    if (!GITHUB_REPO || !GITHUB_TOKEN) {
        console.log('No GITHUB_REPO or GITHUB_TOKEN set, marking job as complete without stitching');
        const outputFolder = `job_${jobId}`;
        await updateJob(jobId, {
            status: 'complete',
            progress: 100,
            output_folder: outputFolder,
        });
        return;
    }

    try {
        const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/dispatches`, {
            method: 'POST',
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                event_type: 'stitch_video',
                client_payload: {
                    job_id: jobId,
                    segment_count: segmentCount,
                    minimax_tasks: JSON.stringify(minimaxTasks),
                    minimax_api_key: MINIMAX_API_KEY
                }
            }),
        });

        if (!res.ok) {
            const errText = await res.text();
            console.error('GitHub Actions trigger failed:', errText);
            await setError(jobId, `GitHub Actions error: ${errText}`);
        } else {
            console.log(`[${jobId}] Successfully triggered GitHub Action for stitching.`);
        }
    } catch (err) {
        console.error('GitHub Actions trigger error:', err);
        await setError(jobId, `Failed to contact GitHub: ${err instanceof Error ? err.message : String(err)}`);
    }
}

// ── Main Handler ──
Deno.serve(async (req: Request) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        const { job_id, script, voice_name, segment_count } = await req.json();

        if (!job_id || !script) {
            return new Response(
                JSON.stringify({ error: 'Missing job_id or script' }),
                { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        // Start pipeline (don't await — return immediately so the caller doesn't timeout)
        // Use EdgeRuntime.waitUntil to keep the function running
        const pipeline = async () => {
            try {
                // Step 1: Generate JSONs
                const { voiceJson, imageJson, videoJson } = await generateJsons(job_id, script, segment_count);

                // Validate JSONs
                const voiceObj = JSON.parse(voiceJson);
                const imageObj = JSON.parse(imageJson);
                const videoObj = JSON.parse(videoJson);

                if (Object.keys(voiceObj).length === 0 || Object.keys(imageObj).length === 0 || Object.keys(videoObj).length === 0) {
                    await setError(job_id, 'Failed to generate valid JSONs. The AI returned empty results. Please try again.');
                    return;
                }

                // Step 2: Generate Voice
                await generateVoice(job_id, voiceJson, voice_name);

                // Step 3: Generate Images
                await generateImages(job_id, imageJson);

                // Step 4: Generate Videos via MiniMax (Async Task Submission)
                const minimaxTasks = await generateVideos(job_id, videoJson);

                // Step 5: Trigger stitcher (it will poll MiniMax tasks and stitch)
                await triggerStitcher(job_id, segment_count, minimaxTasks);
            } catch (err) {
                console.error('Pipeline error:', err);
                await setError(job_id, `Pipeline failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        };

        // Run in background — return response immediately
        // EdgeRuntime.waitUntil keeps the function alive
        (globalThis as any).EdgeRuntime?.waitUntil?.(pipeline());

        // Fallback: If waitUntil is not available, run inline
        // This means the caller must wait, but Supabase Edge Functions support long execution
        if (!(globalThis as any).EdgeRuntime?.waitUntil) {
            await pipeline();
        }

        return new Response(
            JSON.stringify({ success: true, message: 'Pipeline started' }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    } catch (err) {
        console.error('Handler error:', err);
        return new Response(
            JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }
});
