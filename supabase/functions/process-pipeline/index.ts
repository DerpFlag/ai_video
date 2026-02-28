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

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Config ──
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY')!;
const FISH_AUDIO_API_KEY = Deno.env.get('FISH_AUDIO_API_KEY') || '';
const BYTEZ_API_KEY = Deno.env.get('BYTEZ_API_KEY') || '';
const STITCHER_URL = Deno.env.get('STITCHER_URL') || '';

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

    const model = 'google/gemini-2.0-flash-exp:free';

    // Voice JSON
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
2) Rewrite for speech: conversational, short sentences, natural transitions.
3) Optimize for text-to-speech: no symbols, no lists, spell out numbers.
4) Output ONLY valid JSON. No comments. No trailing commas. No text outside JSON. No markdown code fences.

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
    const imagePrompt = `You are an expert visual designer.
Given a JSON of ${segmentCount} text paragraphs (voice1 → voice${segmentCount}), generate a NEW JSON with ${segmentCount} image generation prompts.
Each prompt should describe a key visual frame for the paragraph.

Output: valid JSON only, keys "image1" to "image${segmentCount}", values are descriptive image prompts.
Include: lighting, composition, colors, mood, environment. Keep consistent style across all prompts.
No explanations, no markdown, no extra text. ONLY valid JSON.

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
    const videoPrompt = `You are an expert cinematic director.
Given a JSON of ${segmentCount} image prompts, generate a NEW JSON with ${segmentCount} video generation prompts.
Each prompt should describe a dynamic 5-second video clip.

Output: valid JSON only, keys "video1" to "video${segmentCount}", values are descriptive video prompts.
Include: camera movement, character motion, environmental details, cinematic shots.
No explanations, no markdown, no extra text. ONLY valid JSON.

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
                // Fallback: Use free Google TTS via a public endpoint
                // Store text for later processing
                console.log(`No Fish Audio key, skipping TTS for segment ${i + 1}`);
            }
        } catch (err) {
            console.error(`Voice generation error for segment ${i + 1}:`, err);
        }
    }

    await updateJob(jobId, { progress: 50 });
}

// ── Step 3: Generate Images via Pollinations.ai (100% free, no API key) ──
async function generateImages(jobId: string, imageJson: string) {
    await updateJob(jobId, { status: 'generating_images', progress: 50 });

    const images = JSON.parse(imageJson);
    const imageKeys = Object.keys(images);
    const outputFolder = `job_${jobId}`;

    for (let i = 0; i < imageKeys.length; i++) {
        const prompt = images[imageKeys[i]];
        const progress = 50 + Math.round((i / imageKeys.length) * 20);
        await updateJob(jobId, { progress });

        try {
            // Pollinations.ai — completely free, no API key needed
            const encodedPrompt = encodeURIComponent(prompt);
            const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1280&height=720&model=flux&nologo=true`;

            // Fetch the generated image
            const imgRes = await fetch(imageUrl);
            if (imgRes.ok) {
                const imgBuffer = await imgRes.arrayBuffer();
                const imgBytes = new Uint8Array(imgBuffer);

                // Upload to Supabase Storage
                await supabase.storage
                    .from('pipeline_output')
                    .upload(`${outputFolder}/images/image_${i + 1}.jpg`, imgBytes, {
                        contentType: 'image/jpeg',
                        upsert: true,
                    });
            } else {
                console.error(`Image gen failed for segment ${i + 1}`);
            }
        } catch (err) {
            console.error(`Image generation error for segment ${i + 1}:`, err);
        }
    }

    await updateJob(jobId, { progress: 70 });
}

// ── Step 4: Generate Videos via Bytez API (Wan2.1) ──
async function generateVideos(jobId: string, videoJson: string, imageJson: string) {
    await updateJob(jobId, { status: 'generating_videos', progress: 70 });

    const videos = JSON.parse(videoJson);
    const videoKeys = Object.keys(videos);
    const outputFolder = `job_${jobId}`;

    for (let i = 0; i < videoKeys.length; i++) {
        const prompt = videos[videoKeys[i]];
        const progress = 70 + Math.round((i / videoKeys.length) * 25);
        await updateJob(jobId, { progress });

        try {
            if (BYTEZ_API_KEY) {
                // Use Bytez API with Wan2.1 for text-to-video
                const videoRes = await fetch('https://api.bytez.com/models/v2/Wan-AI/Wan2.1-T2V-14B', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Key ${BYTEZ_API_KEY}`,
                    },
                    body: JSON.stringify({
                        prompt: prompt,
                        // Wan2.1 T2V parameters
                        num_frames: 81,        // ~5 seconds at 16fps
                        height: 480,
                        width: 854,
                    }),
                });

                if (videoRes.ok) {
                    const videoData = await videoRes.json();
                    // The response format depends on the Bytez API
                    // It may return a URL to the generated video or the video data directly
                    const videoUrl = videoData.output?.url || videoData.url || videoData.output;

                    if (videoUrl && typeof videoUrl === 'string') {
                        // Download and upload to Supabase Storage
                        const dlRes = await fetch(videoUrl);
                        if (dlRes.ok) {
                            const vidBuffer = await dlRes.arrayBuffer();
                            const vidBytes = new Uint8Array(vidBuffer);
                            await supabase.storage
                                .from('pipeline_output')
                                .upload(`${outputFolder}/videos/video_${i + 1}.mp4`, vidBytes, {
                                    contentType: 'video/mp4',
                                    upsert: true,
                                });
                        }
                    } else if (videoData.output && typeof videoData.output !== 'string') {
                        // If the response is binary/base64
                        console.log(`Video ${i + 1}: Received non-URL response, storing metadata`);
                    }
                } else {
                    const errText = await videoRes.text();
                    console.error(`Bytez video gen failed for segment ${i + 1}:`, errText);
                }
            } else {
                console.log(`No Bytez API key, skipping video gen for segment ${i + 1}`);
            }
        } catch (err) {
            console.error(`Video generation error for segment ${i + 1}:`, err);
        }
    }

    await updateJob(jobId, { progress: 90 });
}

// ── Step 5: Trigger Stitcher Service ──
async function triggerStitcher(jobId: string, segmentCount: number) {
    await updateJob(jobId, { status: 'stitching', progress: 92 });

    if (!STITCHER_URL) {
        console.log('No STITCHER_URL set, marking job as complete without stitching');
        const outputFolder = `job_${jobId}`;
        await updateJob(jobId, {
            status: 'complete',
            progress: 100,
            output_folder: outputFolder,
        });
        return;
    }

    try {
        const res = await fetch(`${STITCHER_URL}/stitch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ job_id: jobId, segment_count: segmentCount }),
        });

        if (!res.ok) {
            const errText = await res.text();
            console.error('Stitcher call failed:', errText);
            await setError(jobId, `Stitcher service error: ${errText}`);
        }
        // Stitcher runs in background — it will update the job status when done
    } catch (err) {
        console.error('Stitcher trigger error:', err);
        await setError(jobId, `Failed to contact stitcher service: ${err instanceof Error ? err.message : String(err)}`);
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

                // Step 4: Generate Videos
                await generateVideos(job_id, videoJson, imageJson);

                // Step 5: Trigger stitcher to concat + mix audio + speed-adjust
                await triggerStitcher(job_id, segment_count);
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
