const SUPABASE_URL = 'https://acpxzjrjhvvnwnqzgbxk.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjcHh6anJqaHZ2bnducXpnYnhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzExNTkwMTcsImV4cCI6MjA4NjczNTAxN30.4c4QGwY1nTAZHibPDv44BypkJKCjb_zU8LalSy5d8YU';

async function testQwenTTS() {
    console.log('Testing Qwen TTS on Hugging Face (via Edge Function)...');
    const res = await fetch(`${SUPABASE_URL}/functions/v1/debug-tts`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        },
        body: JSON.stringify({
            text: 'Hello, this is a test of the Qwen 3 TTS model. I am testing if this works better than the Edge TTS service.'
        })
    });
    const data = await res.json();
    console.log('Result:', JSON.stringify(data, null, 2));
}

testQwenTTS();
