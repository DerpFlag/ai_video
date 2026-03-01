// ============================================================
// AI Video Stitcher Script (Ken Burns Edition)
// 
// This script runs via GitHub Actions `ubuntu-latest` runner.
// It receives `JOB_ID` and `SEGMENT_COUNT` via env vars.
// ============================================================

const ffmpeg = require('fluent-ffmpeg');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ── Config ──
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const JOB_ID = process.env.JOB_ID;
const SEGMENT_COUNT = parseInt(process.env.SEGMENT_COUNT || '0');

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !JOB_ID || !SEGMENT_COUNT) {
    console.error("Missing required environment variables.");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Helpers ──

function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        const client = url.startsWith('https') ? https : http;
        client.get(url, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                reject(new Error(`Download failed: ${res.statusCode} for ${url}`));
                return;
            }
            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
            file.on('error', reject);
        }).on('error', reject);
    });
}

function getDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);
            resolve(metadata.format.duration || 0);
        });
    });
}

function runFfmpeg(command) {
    return new Promise((resolve, reject) => {
        command
            .on('end', resolve)
            .on('error', (err, stdout, stderr) => {
                console.error('FFmpeg Error:', err.message);
                console.error('FFmpeg stderr:', stderr);
                reject(err);
            })
            .run();
    });
}

async function updateJob(jobId, updates) {
    const { error } = await supabase.from('jobs').update(updates).eq('id', jobId);
    if (error) console.error('Update job error:', error);
}

// ── Main Script ──
async function main() {
    console.log(`🎬 Starting Ken Burns stitcher for Job ID: ${JOB_ID}`);

    const workDir = path.join('/tmp', `stitch_${JOB_ID}`);
    try {
        fs.mkdirSync(workDir, { recursive: true });
        const outputFolder = `job_${JOB_ID}`;

        await updateJob(JOB_ID, { current_task: 'Synthesizing motion video...', status: 'stitching', progress: 75 });

        const videoFiles = [];
        const audioFiles = [];

        for (let i = 1; i <= SEGMENT_COUNT; i++) {
            const videoPath = path.join(workDir, `video_${i}.mp4`);
            const imagePath = path.join(workDir, `image_${i}.jpg`);
            const audioPath = path.join(workDir, `voice_${i}.mp3`);

            const imageUrl = `${SUPABASE_URL}/storage/v1/object/public/pipeline_output/${outputFolder}/images/image_${i}.jpg`;
            const audioUrl = `${SUPABASE_URL}/storage/v1/object/public/pipeline_output/${outputFolder}/audio/voice_${i}.mp3`;

            // 1. Download audio and get duration
            try {
                console.log(`[${JOB_ID}] Downloading audio segment ${i}...`);
                await downloadFile(audioUrl, audioPath);
                audioFiles.push(audioPath);
            } catch (e) {
                console.warn(`[${JOB_ID}] Audio segment ${i} download failed:`, e.message);
            }

            let duration = 5; // Default if audio missing
            if (fs.existsSync(audioPath)) {
                duration = await getDuration(audioPath);
            }
            console.log(`[${JOB_ID}] Segment ${i} duration: ${duration.toFixed(2)}s`);

            // 2. Generate Ken Burns video from image
            try {
                console.log(`[${JOB_ID}] Downloading image segment ${i}...`);
                await downloadFile(imageUrl, imagePath);

                // Randomized Motion Style
                const motions = ['zoom_in', 'zoom_out', 'pan_right', 'pan_left'];
                const style = motions[(i - 1) % motions.length]; // cycle through motions for variety

                const fps = 30;
                const totalFrames = Math.max(Math.ceil(duration * fps), 1);
                let filter = '';

                // Note: zoompan requires careful expressions. 'n' is frame number.
                // We use 1280x720 as standard.
                if (style === 'zoom_in') {
                    filter = `scale=1920:-1,zoompan=z='min(zoom+0.0015,1.5)':d=${totalFrames}:s=1280x720:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
                } else if (style === 'zoom_out') {
                    filter = `scale=1920:-1,zoompan=z='if(lte(zoom,1.0),1.5,zoom-0.0015)':d=${totalFrames}:s=1280x720:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
                } else if (style === 'pan_right') {
                    filter = `scale=1920:-1,zoompan=z=1.3:d=${totalFrames}:s=1280x720:x='((iw-(iw/zoom))/d)*n':y='(ih-(ih/zoom))/2'`;
                } else {
                    filter = `scale=1920:-1,zoompan=z=1.3:d=${totalFrames}:s=1280x720:x='(iw-(iw/zoom))-((iw-(iw/zoom))/d)*n':y='(ih-(ih/zoom))/2'`;
                }

                console.log(`[${JOB_ID}] Encoding segment ${i} with ${style} effect...`);
                await runFfmpeg(
                    ffmpeg()
                        .input(imagePath)
                        .inputOptions(['-loop', '1'])
                        .outputOptions([
                            '-c:v', 'libx264',
                            '-t', duration.toFixed(3),
                            '-pix_fmt', 'yuv420p',
                            '-vf', filter,
                            '-r', fps.toString()
                        ])
                        .output(videoPath)
                );
                videoFiles.push(videoPath);
                await updateJob(JOB_ID, { progress: Math.min(75 + Math.floor((i / SEGMENT_COUNT) * 15), 90) });
            } catch (e) {
                console.error(`[${JOB_ID}] Image segment ${i} processing failed:`, e.message);
            }
        }

        if (videoFiles.length === 0) throw new Error('No video segments generated.');

        // 3. Concat all segments
        await updateJob(JOB_ID, { current_task: 'Stitching video segments together...', progress: 92 });
        console.log(`[${JOB_ID}] Stitching ${videoFiles.length} segments together...`);
        const concatVideoPath = path.join(workDir, 'concat_video.mp4');
        const concatListPath = path.join(workDir, 'video_list.txt');
        const listContent = videoFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
        fs.writeFileSync(concatListPath, listContent);

        await runFfmpeg(
            ffmpeg()
                .input(concatListPath)
                .inputOptions(['-f', 'concat', '-safe', '0'])
                .outputOptions(['-c', 'copy'])
                .output(concatVideoPath)
        );

        // 4. Concat all audio
        let finalAudioPath = null;
        if (audioFiles.length > 0) {
            await updateJob(JOB_ID, { current_task: 'Merging voiceover segments...', progress: 94 });
            console.log(`[${JOB_ID}] Merging voiceover segments...`);
            finalAudioPath = path.join(workDir, 'final_audio.mp3');
            const audioListPath = path.join(workDir, 'audio_list.txt');
            const audioListContent = audioFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
            fs.writeFileSync(audioListPath, audioListContent);

            await runFfmpeg(
                ffmpeg()
                    .input(audioListPath)
                    .inputOptions(['-f', 'concat', '-safe', '0'])
                    .outputOptions(['-c', 'copy'])
                    .output(finalAudioPath)
            );
        }

        // 5. Final Assembly (Video + Audio)
        await updateJob(JOB_ID, { current_task: 'Finalizing master video...', progress: 96 });
        const finalOutputPath = path.join(workDir, 'final_output.mp4');
        console.log(`[${JOB_ID}] Performing final assembly...`);

        if (finalAudioPath) {
            await runFfmpeg(
                ffmpeg()
                    .input(concatVideoPath)
                    .input(finalAudioPath)
                    .outputOptions([
                        '-c:v', 'copy',
                        '-c:a', 'aac',
                        '-map', '0:v:0',
                        '-map', '1:a:0',
                        '-shortest'
                    ])
                    .output(finalOutputPath)
            );
        } else {
            fs.copyFileSync(concatVideoPath, finalOutputPath);
        }

        // 6. Upload
        console.log(`[${JOB_ID}] Uploading master video to Supabase...`);
        const finalBuffer = fs.readFileSync(finalOutputPath);
        await supabase.storage
            .from('pipeline_output')
            .upload(`${outputFolder}/final_video.mp4`, finalBuffer, {
                contentType: 'video/mp4',
                upsert: true
            });

        await updateJob(JOB_ID, {
            status: 'complete',
            progress: 100,
            current_task: 'All assets ready!',
            output_folder: outputFolder
        });

        console.log(`[${JOB_ID}] ✅ Done! Video is ready in Storage.`);

    } catch (err) {
        console.error("Master Stitch Error:", err);
        await updateJob(JOB_ID, { status: 'error', error_message: `Stitching failed: ${err.message}` });
        process.exit(1);
    } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}

main();
