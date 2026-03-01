import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { script, voice_name, segment_count } = body;

        if (!script || !voice_name || !segment_count) {
            return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 });
        }

        // 1. Create job row in Supabase
        const { data: job, error: dbError } = await supabase
            .from('jobs')
            .insert({
                script,
                voice_name: voice_name || 'en-US-AndrewMultilingualNeural',
                segment_count: parseInt(segment_count) || 5,
                status: 'pending',
                progress: 0,
            })
            .select()
            .single();

        if (dbError || !job) {
            console.error('DB Error:', dbError);
            return NextResponse.json({ success: false, error: dbError?.message || 'Failed to create job' }, { status: 500 });
        }

        // 2. Trigger the Supabase Edge Function to start processing
        // This is fire-and-forget — we don't wait for it to complete
        const edgeFunctionUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/process-pipeline`;

        fetch(edgeFunctionUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
            },
            body: JSON.stringify({
                job_id: job.id,
                script,
                voice_name: voice_name || 'en-US-AndrewMultilingualNeural',
                segment_count: parseInt(segment_count) || 5,
            }),
        }).catch(err => {
            console.error('Edge function trigger error (non-blocking):', err);
        });

        return NextResponse.json({ success: true, job_id: job.id });
    } catch (err) {
        console.error('Submit error:', err);
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
    }
}
