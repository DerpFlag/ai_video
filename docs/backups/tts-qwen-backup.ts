/**
 * BACKUP: Qwen TTS (Hugging Face Space) implementation.
 * Do not import this from process-pipeline. Copy-paste into index.ts if reverting to Qwen.
 *
 * Requires: supabase client, updateJob, addLog, withRetry in scope.
 * Voice clone requires: voice_clones table, reference_voices bucket.
 */

// ── Constants (copy these back into index.ts when reverting) ──
// const TTS_DELAY_MS = 5000;
// const TTS_RETRY_DELAY_MS = 8000;
// const TTS_VOICE_CLONE_COOLDOWN_AFTER_2_MS = 22000;

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
                    if (lastEventType === 'error') {
                        throw new Error(`TTS Space returned error (rate limit or overload—often on 3rd+ request). Wait longer between segments and retry.`);
                    }
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
                    if (e instanceof Error && e.message.includes('rate limit or overload')) throw e;
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

// ── generateVoice (Qwen version: with cooldown and voice clone) ──
// async function generateVoice(jobId: string, voiceJson: string, speaker: string = "Ryan") {
//     await updateJob(jobId, { status: 'generating_voice', progress: 35 });
//     await addLog(jobId, `Synthesizing high-quality voice using Qwen-TTS Speaker: ${speaker}...`);
//
//     const voices = JSON.parse(voiceJson);
//     const voiceKeys = Object.keys(voices);
//     const outputFolder = `job_${jobId}`;
//     const isVoiceClone = speaker.startsWith('ref:');
//     const segmentDelayMs = isVoiceClone ? 7000 : TTS_DELAY_MS;
//
//     for (let i = 0; i < voiceKeys.length; i++) {
//         if (i > 0) await new Promise(r => setTimeout(r, segmentDelayMs));
//         if (isVoiceClone && i >= 2 && i % 2 === 0) {
//             await addLog(jobId, `Cooldown 22s before segment ${i + 1} (avoids Space error on 3rd+ request)...`, 'info');
//             await new Promise(r => setTimeout(r, TTS_VOICE_CLONE_COOLDOWN_AFTER_2_MS));
//         }
//
//         const text = voices[voiceKeys[i]];
//         await addLog(jobId, `Synthesizing voice segment ${i + 1}/${voiceKeys.length}...`);
//
//         let lastErr: Error | null = null;
//         try {
//             const audioBytes = await withRetry(
//                 () => qwenSpaceTTS(text, speaker),
//                 3, TTS_RETRY_DELAY_MS,
//                 (err, count) => {
//                     lastErr = err instanceof Error ? err : new Error(String(err));
//                     addLog(jobId, `Retrying segment ${i + 1} (Attempt ${count}/3): ${lastErr.message}`, 'warning');
//                 }
//             );
//
//             await supabase.storage
//                 .from('pipeline_output')
//                 .upload(`${outputFolder}/audio/voice_${i + 1}.mp3`, audioBytes, {
//                     contentType: 'audio/mpeg',
//                     upsert: true,
//                 });
//
//             await addLog(jobId, `Voice segment ${i + 1} finalized and stored.`);
//         } catch (err) {
//             lastErr = err instanceof Error ? err : new Error(String(err));
//             await addLog(jobId, `Voice segment ${i + 1} failed after retries: ${lastErr.message}`, 'error');
//             await addLog(jobId, i + 1 < voiceKeys.length ? `Skipping segment ${i + 1}; continuing with segment ${i + 2} of ${voiceKeys.length}.` : `Skipping segment ${i + 1}. Voice step done.`, 'warning');
//             await updateJob(jobId, { progress: Math.min(35 + Math.floor(((i + 1) / voiceKeys.length) * 5), 39) });
//             await new Promise(r => setTimeout(r, 2000));
//         }
//     }
//
//     await addLog(jobId, 'Voice synthesis step complete.', 'success');
//     await updateJob(jobId, { progress: 40 });
// }
