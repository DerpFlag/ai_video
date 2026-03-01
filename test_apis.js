const FISH_KEY = process.env.FISH_KEY;
const BYTEZ_KEY = process.env.BYTEZ_KEY;

async function testBytez() {
    const models = [
        'Wan-AI/Wan2.1-T2V-14B',
        'Wan-AI/Wan2.1-T2V-1.3B',
        'KwaiVGI/LiveKraken-1.5',
        'stabilityai/stable-video-diffusion-img2vid-xt'
    ];

    for (const model of models) {
        console.log(`\nTesting Bytez: ${model}...`);
        try {
            const res = await fetch(`https://api.bytez.com/models/v2/${model}`, {
                method: 'POST',
                headers: { 'Authorization': `Key ${BYTEZ_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'A dog' })
            });
            const data = await res.json();
            if (res.ok) {
                console.log(`✅ ${model} WORKS!`);
            } else {
                console.log(`❌ ${model} FAILED: ${data.error || JSON.stringify(data)}`);
            }
        } catch (e) {
            console.log(`❌ ${model} HTTP ERROR: ${e.message}`);
        }
    }
}

async function testPollinations() {
    console.log(`\nTesting Pollinations...`);
    const prompt = 'A dog running in a field, highly detailed, cinematic lighting, photorealistic, 4k';
    const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1280&height=720&model=flux&nologo=true`;

    try {
        const res = await fetch(imageUrl);
        if (res.ok) {
            console.log(`✅ Pollinations WORKS! (Status ${res.status})`);
        } else {
            console.log(`❌ Pollinations FAILED: ${res.status}`);
        }
    } catch (e) {
        console.log(`❌ Pollinations HTTP ERROR: ${e.message}`);
    }
}

testPollinations();
//testBytez();
