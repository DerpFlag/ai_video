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
            file.on('finish', () => {
                file.close();
                // Validate file exists and is not empty
                if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
                    resolve();
                } else {
                    reject(new Error(`Downloaded file is empty: ${destPath}`));
                }
            });
            file.on('error', (err) => {
                fs.unlink(destPath, () => { });
                reject(err);
            });
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
    const { error } = await supabase.from('jobs').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', jobId);
    if (error) console.error('Update job error:', error);
}

async function addLog(jobId, message, type = 'info') {
    const timestamp = new Date().toISOString();
    console.log(`[${type.toUpperCase()}] ${message}`);

    const { data } = await supabase.from('jobs').select('logs').eq('id', jobId).single();
    const logs = data?.logs || [];
    logs.push({ message, type, timestamp });

    await updateJob(jobId, { current_task: message, logs });
}

// ── Main Script ──
async function main() {
    await addLog(JOB_ID, `🎬 Starting cinematic video assembly...`);

    const workDir = path.resolve('/tmp', `stitch_${JOB_ID}`);
    try {
        if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
        const outputFolder = `job_${JOB_ID}`;

        await updateJob(JOB_ID, { current_task: 'Synthesizing motion video...', status: 'stitching', progress: 75 });
        await addLog(JOB_ID, `Preparing to process ${SEGMENT_COUNT} segments.`, 'info');

        const videoFiles = [];
        const audioFiles = [];

        for (let i = 1; i <= SEGMENT_COUNT; i++) {
            const videoPath = path.resolve(workDir, `video_${i}.mp4`);
            const imagePath = path.resolve(workDir, `image_${i}.jpg`);
            const audioPath = path.resolve(workDir, `voice_${i}.mp3`);

            const imageUrl = `${SUPABASE_URL}/storage/v1/object/public/pipeline_output/${outputFolder}/images/image_${i}.jpg`;
            const audioUrl = `${SUPABASE_URL}/storage/v1/object/public/pipeline_output/${outputFolder}/audio/voice_${i}.mp3`;

            // 1. Download audio and get duration
            try {
                await downloadFile(audioUrl, audioPath);
                audioFiles.push(audioPath);
            } catch (e) {
                await addLog(JOB_ID, `Missing audio for segment ${i}, using default 6s.`, 'warning');
            }

            let duration = 6;
            if (fs.existsSync(audioPath)) {
                duration = await getDuration(audioPath);
            }

            // 2. Generate Ken Burns video
            try {
                await addLog(JOB_ID, `Processing segment ${i}: Downloading assets...`);
                await downloadFile(imageUrl, imagePath);

                const motions = ['zoom_in', 'zoom_out', 'pan_right', 'pan_left'];
                const style = motions[(i - 1) % motions.length];
                const fps = 30;
                const totalFrames = Math.max(Math.ceil(duration * fps), 2);

                // Quality Scaling: Ensure we have vertical/horizontal headroom for the pan
                let filter = `scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160,`;

                if (style === 'zoom_in') {
                    filter += `zoompan=z='min(zoom+0.0015,1.5)':d=${totalFrames}:s=1920x1080:fps=30:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
                } else if (style === 'zoom_out') {
                    filter += `zoompan=z='if(lte(zoom,1.0),1.5,zoom-0.0015)':d=${totalFrames}:s=1920x1080:fps=30:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
                } else if (style === 'pan_right') {
                    filter += `zoompan=z=1.3:d=${totalFrames}:s=1920x1080:fps=30:x='((iw-(iw/zoom))/${totalFrames})*n':y='(ih-(ih/zoom))/2'`;
                } else {
                    filter += `zoompan=z=1.3:d=${totalFrames}:s=1920x1080:fps=30:x='(iw-(iw/zoom))-((iw-(iw/zoom))/${totalFrames})*n':y='(ih-(ih/zoom))/2'`;
                }

                await addLog(JOB_ID, `Encoding segment ${i} (${duration.toFixed(1)}s) with ${style}...`);

                // Retry encoding once if it fails (FFmpeg can be flaky with zoompan)
                let attempts = 0;
                while (attempts < 2) {
                    try {
                        await runFfmpeg(
                            ffmpeg()
                                .input(imagePath)
                                .inputOptions(['-loop', '1'])
                                .outputOptions([
                                    '-c:v', 'libx264',
                                    '-t', duration.toFixed(3),
                                    '-pix_fmt', 'yuv420p',
                                    '-vf', filter,
                                    '-r', '30'
                                ])
                                .output(videoPath)
                        );
                        break;
                    } catch (e) {
                        attempts++;
                        if (attempts >= 2) throw e;
                        await new Promise(r => setTimeout(r, 1000));
                    }
                }

                if (fs.existsSync(videoPath) && fs.statSync(videoPath).size > 0) {
                    videoFiles.push(videoPath);
                } else {
                    throw new Error(`Visual segment ${i} encode failed (empty output).`);
                }

                await updateJob(JOB_ID, { progress: Math.min(75 + Math.floor((i / SEGMENT_COUNT) * 15), 90) });
            } catch (e) {
                await addLog(JOB_ID, `Segment ${i} visual component failed: ${e.message}`, 'error');
            }
        }

        if (videoFiles.length === 0) throw new Error('No video segments successfully created.');

        // 3. Merged Assembly via complex filter
        await addLog(JOB_ID, `Merging all segments into final creation...`);
        const finalOutputPath = path.resolve(workDir, 'master.mp4');

        let command = ffmpeg();
        videoFiles.forEach(f => command = command.input(f));
        audioFiles.forEach(f => command = command.input(f));

        const vCount = videoFiles.length;
        const aCount = audioFiles.length;

        let filterStr = "";
        for (let i = 0; i < vCount; i++) filterStr += `[${i}:v:0]`;
        filterStr += `concat=n=${vCount}:v=1:a=0[outv];`;

        if (aCount > 0) {
            for (let i = 0; i < aCount; i++) filterStr += `[${vCount + i}:a:0]`;
            filterStr += `concat=n=${aCount}:v=0:a=1[outa]`;
        }

        command = command.complexFilter(filterStr);
        const outputOptions = ['-map [outv]'];
        if (aCount > 0) {
            outputOptions.push('-map [outa]');
            outputOptions.push('-c:a aac');
        }
        outputOptions.push('-c:v libx264');
        outputOptions.push('-pix_fmt yuv420p');
        outputOptions.push('-shortest');

        await runFfmpeg(
            command
                .outputOptions(outputOptions)
                .output(finalOutputPath)
        );

        // 6. Upload
        await addLog(JOB_ID, `Uploading final master file...`);
        const finalBuffer = fs.readFileSync(finalOutputPath);
        await supabase.storage
            .from('pipeline_output')
            .upload(`${outputFolder}/final_video.mp4`, finalBuffer, {
                contentType: 'video/mp4',
                upsert: true
            });

        await addLog(JOB_ID, `✅ Your video is ready for viewing!`, 'success');
        await updateJob(JOB_ID, {
            status: 'complete',
            progress: 100,
            output_folder: outputFolder
        });

    } catch (err) {
        await addLog(JOB_ID, `CRITICAL FAILURE: ${err.message}`, 'error');
        await updateJob(JOB_ID, { status: 'error', error_message: err.message });
        process.exit(1);
    } finally {
        if (fs.existsSync(workDir)) {
            try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { }
        }
    }
}

main();
