#!/usr/bin/env node
/**
 * Test script: call Qwen TTS Space and print raw SSE stream.
 * Run: node scripts/test-qwen-tts-stream.mjs
 * Run 3 times in a loop to simulate 3 segments: node scripts/test-qwen-tts-stream.mjs 3
 *
 * Uses generate_custom_voice (no Supabase). To test voice clone you need ref audio URL + transcript.
 */
const SEGMENTS = parseInt(process.env.SEGMENTS || process.argv[2] || '1', 10);
const BASE = 'https://qwen-qwen3-tts.hf.space';
const CALL_URL = `${BASE}/gradio_api/call/generate_custom_voice`;

async function oneCall(segmentIndex) {
    const text = segmentIndex === 0
        ? 'An astronaut walking on a neon-lit cyber-punk city street.'
        : `Segment ${segmentIndex + 1} of the story. The astronaut continues through the city.`;
    console.log(`\n--- Segment ${segmentIndex + 1} ---`);
    console.log('Request text:', text.slice(0, 50) + '...');

    const startRes = await fetch(CALL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            data: [text, 'English', 'Ryan', 'natural and engaging', '1.7B']
        })
    });
    if (!startRes.ok) {
        console.log('Start failed:', startRes.status, await startRes.text());
        return;
    }
    const { event_id } = await startRes.json();
    console.log('Event ID:', event_id);

    const streamUrl = `${CALL_URL}/${event_id}`;
    const streamRes = await fetch(streamUrl);
    if (!streamRes.ok) {
        console.log('Stream failed:', streamRes.status, await streamRes.text());
        return;
    }

    const reader = streamRes.body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        full += decoder.decode(value, { stream: true });
    }
    console.log('Raw stream length:', full.length);
    console.log('Raw stream (last 1200 chars):');
    console.log(full.slice(-1200));
    const hasUrl = /"url"\s*:\s*"https?:/.test(full);
    console.log('Contains URL:', hasUrl);
}

async function main() {
    console.log('Qwen TTS stream test. Segments to run:', SEGMENTS);
    for (let i = 0; i < SEGMENTS; i++) {
        await oneCall(i);
        if (i < SEGMENTS - 1) {
            console.log('\nWaiting 5s before next segment...');
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}
main().catch(e => { console.error(e); process.exit(1); });
