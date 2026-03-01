Deno.serve(async (req) => {
    const HF_TOKEN = Deno.env.get('HF_TOKEN');
    const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY');

    return new Response(JSON.stringify({
        has_HF_TOKEN: !!HF_TOKEN,
        has_OPENROUTER_API_KEY: !!OPENROUTER_API_KEY,
        HF_TOKEN_LENGTH: HF_TOKEN?.length || 0,
        OPENROUTER_API_KEY_LENGTH: OPENROUTER_API_KEY?.length || 0,
    }), { headers: { 'Content-Type': 'application/json' } });
});
