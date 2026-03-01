import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

Deno.serve(async (req) => {
    const { data: buckets, error } = await supabase.storage.listBuckets();
    if (error) return new Response(JSON.stringify({ error }), { status: 500 });

    const results: any[] = [];
    for (const bucket of buckets) {
        const { data: files } = await supabase.storage.from(bucket.name).list();
        results.push({ name: bucket.name, files });
    }

    return new Response(JSON.stringify(results), {
        headers: { 'Content-Type': 'application/json' }
    });
});
