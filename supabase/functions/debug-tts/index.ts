import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function testQwenSpaceTTS(text: string): Promise<{ success: boolean; dataLength?: number; error?: string; logs: string[] }> {
    const logs: string[] = [];
    try {
        const baseUrl = "https://qwen-qwen3-tts.hf.space";
        const callUrl = `${baseUrl}/gradio_api/call/generate_custom_voice`;

        logs.push(`Starting Task: ${callUrl}`);

        // 1. POST to start the task
        const startResponse = await fetch(callUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: [
                    text,
                    "English", // Language
                    "Ryan",    // Speaker
                    "cheerful and energetic", // Style
                    "1.7B"     // Model
                ]
            })
        });

        if (!startResponse.ok) {
            const errBody = await startResponse.text();
            throw new Error(`Failed to start task: ${startResponse.status} ${errBody}`);
        }

        const { event_id } = await startResponse.json();
        logs.push(`Event ID: ${event_id}`);

        // 2. Poll/Stream for the result
        // Since we are in an Edge Function, we can just fetch and wait for the SSE stream to finish or give us the data.
        const dataUrl = `${callUrl}/${event_id}`;
        logs.push(`Polling Result: ${dataUrl}`);

        const resultResponse = await fetch(dataUrl);
        if (!resultResponse.ok) {
            throw new Error(`Failed to poll result: ${resultResponse.status}`);
        }

        // We need to parse the SSE stream manually in Deno
        const reader = resultResponse.body?.getReader();
        if (!reader) throw new Error("No response body reader available");

        let audioUrl = "";
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            logs.push(`Received chunk: ${chunk.substring(0, 100)}...`);

            // SSE events are like "event: ...\ndata: ...\n\n"
            const lines = chunk.split('\n');
            for (const line of lines) {
                if (line.startsWith('data:')) {
                    const dataStr = line.replace('data:', '').trim();
                    try {
                        const dataObj = JSON.parse(dataStr);
                        if (Array.isArray(dataObj) && dataObj[0] && dataObj[0].url) {
                            audioUrl = dataObj[0].url;
                            logs.push(`Found Audio URL: ${audioUrl}`);
                            break;
                        }
                    } catch (e) {
                        // Not JSON, skip
                    }
                }
            }
            if (audioUrl) break;
        }

        if (!audioUrl) {
            throw new Error("Could not find audio URL in SSE stream");
        }

        // 3. Download the audio
        logs.push(`Downloading audio...`);
        const audioRes = await fetch(audioUrl);
        if (!audioRes.ok) throw new Error(`Failed to download audio: ${audioRes.status}`);

        const audioBuffer = await audioRes.arrayBuffer();
        return { success: true, dataLength: audioBuffer.byteLength, logs };

    } catch (e: any) {
        logs.push(`Error: ${e.message}`);
        return { success: false, error: e.message, logs };
    }
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    try {
        const { text } = await req.json();
        const result = await testQwenSpaceTTS(text || 'Hello, testing the Qwen Space via Gradio 5 API.');
        return new Response(JSON.stringify(result), { headers: corsHeaders });
    } catch (e: any) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers: corsHeaders });
    }
});
