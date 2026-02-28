// ============================================================
// AI Video Stitcher Script (GitHub Actions Version)
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

// Download a file from URL to local path
function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        const client = url.startsWith('https') ? https : http;
        client.get(url, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                // Follow redirect
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

// Get media duration in seconds
function getDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);
            resolve(metadata.format.duration || 0);
        });
    });
}

// Run an ffmpeg command as a promise
function runFfmpeg(command) {
    return new Promise((resolve, reject) => {
        command
            .on('end', resolve)
            .on('error', reject)
            .run();
    });
}

// Update job in Supabase
async function updateJob(jobId, updates) {
    const { error } = await supabase.from('jobs').update(updates).eq('id', jobId);
    if (error) console.error('Update job error:', error);
}

// ── Main Script ──
async function main() {
    console.log(`🎬 Starting stitcher for Job ID: ${JOB_ID}`);

    const workDir = path.join('/tmp', `stitch_${JOB_ID}`);
    try {
        fs.mkdirSync(workDir, { recursive: true });
        const outputFolder = `job_${JOB_ID}`;

        await updateJob(JOB_ID, { status: 'stitching', progress: 96 });

        // ── Step 1: Download all segments ──
        console.log(`[${JOB_ID}] Downloading ${SEGMENT_COUNT} video + audio segments...`);

        const videoFiles = [];
        const audioFiles = [];

        for (let i = 1; i <= SEGMENT_COUNT; i++) {
            const videoPath = path.join(workDir, `video_${i}.mp4`);
            const imagePath = path.join(workDir, `image_${i}.jpg`);
            const audioPath = path.join(workDir, `voice_${i}.mp3`);

            // Need the storage download public URLs
            const videoUrl = `${SUPABASE_URL}/storage/v1/object/public/pipeline_output/${outputFolder}/videos/video_${i}.mp4`;
            const imageUrl = `${SUPABASE_URL}/storage/v1/object/public/pipeline_output/${outputFolder}/images/image_${i}.jpg`;
            const audioUrl = `${SUPABASE_URL}/storage/v1/object/public/pipeline_output/${outputFolder}/audio/voice_${i}.mp3`;

            let hasVideo = false;
            try {
                await downloadFile(videoUrl, videoPath);
                videoFiles.push(videoPath);
                hasVideo = true;
            } catch (e) {
                console.warn(`[${JOB_ID}] Video segment ${i} not found, trying image fallback...`);
            }

            if (!hasVideo) {
                try {
                    await downloadFile(imageUrl, imagePath);
                    console.log(`[${JOB_ID}] Converting image ${i} to 5s video slice...`);
                    await runFfmpeg(
                        ffmpeg()
                            .input(imagePath)
                            .inputOptions(['-loop', '1'])
                            .outputOptions([
                                '-c:v', 'libx264',
                                '-t', '5',
                                '-pix_fmt', 'yuv420p',
                                '-vf', 'scale=854:480:force_original_aspect_ratio=increase,crop=854:480',
                                '-r', '30'
                            ])
                            .output(videoPath)
                    );
                    videoFiles.push(videoPath);
                } catch (e) {
                    console.warn(`[${JOB_ID}] Image segment ${i} not found either!`);
                }
            }

            try {
                await downloadFile(audioUrl, audioPath);
                audioFiles.push(audioPath);
            } catch (e) {
                console.warn(`[${JOB_ID}] Audio segment ${i} not found, skipping`);
            }
        }

        if (videoFiles.length === 0) {
            throw new Error('No video segments found to stitch (both video and image fallbacks failed)');
        }

        // ── Step 2: Concatenate all videos ──
        console.log(`[${JOB_ID}] Concatenating ${videoFiles.length} videos...`);
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

        // ── Step 3: Concatenate all audio voiceovers ──
        let concatAudioPath = null;
        if (audioFiles.length > 0) {
            console.log(`[${JOB_ID}] Concatenating ${audioFiles.length} audio files...`);
            concatAudioPath = path.join(workDir, 'concat_audio.mp3');

            const audioListPath = path.join(workDir, 'audio_list.txt');
            const audioListContent = audioFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
            fs.writeFileSync(audioListPath, audioListContent);

            await runFfmpeg(
                ffmpeg()
                    .input(audioListPath)
                    .inputOptions(['-f', 'concat', '-safe', '0'])
                    .outputOptions(['-c', 'copy'])
                    .output(concatAudioPath)
            );
        }

        // ── Step 4: Get durations ──
        const videoDuration = await getDuration(concatVideoPath);
        const audioDuration = concatAudioPath ? await getDuration(concatAudioPath) : videoDuration;

        console.log(`[${JOB_ID}] Video duration: ${videoDuration.toFixed(2)}s, Audio duration: ${audioDuration.toFixed(2)}s`);

        // ── Step 5: Speed-adjust video to match audio ──
        let adjustedVideoPath = concatVideoPath;
        if (Math.abs(videoDuration - audioDuration) > 0.5 && concatAudioPath) {
            console.log(`[${JOB_ID}] Adjusting video speed to match audio...`);
            adjustedVideoPath = path.join(workDir, 'adjusted_video.mp4');

            const speedFactor = videoDuration / audioDuration;
            const ptsFilter = `setpts=PTS*${(1 / speedFactor).toFixed(6)}`;
            const atempoFilter = speedFactor > 2
                ? `atempo=2.0,atempo=${(speedFactor / 2).toFixed(6)}`
                : `atempo=${speedFactor.toFixed(6)}`;

            await runFfmpeg(
                ffmpeg()
                    .input(concatVideoPath)
                    .videoFilters(ptsFilter)
                    .audioFilters(atempoFilter)
                    .outputOptions(['-r', '30'])
                    .output(adjustedVideoPath)
            );
        }

        // ── Step 6: Mix audio — video audio at 30%, voiceover at 100% ──
        const finalOutputPath = path.join(workDir, 'final_output.mp4');

        if (concatAudioPath) {
            console.log(`[${JOB_ID}] Mixing audio: video at 30%, voiceover at 100%...`);

            const command = ffmpeg()
                .input(adjustedVideoPath)
                .input(concatAudioPath)
                .complexFilter([
                    '[0:a]volume=0.3[va]',
                    '[1:a]volume=1.0[oa]',
                    '[va][oa]amix=inputs=2:duration=longest:dropout_transition=2[a]'
                ])
                .outputOptions([
                    '-map', '0:v',
                    '-map', '[a]',
                    '-c:v', 'copy',
                    '-c:a', 'aac',
                    '-b:a', '192k',
                    '-shortest'
                ])
                .output(finalOutputPath);

            await runFfmpeg(command);
        } else {
            fs.copyFileSync(adjustedVideoPath, finalOutputPath);
        }

        // ── Step 7: Upload final video to Supabase Storage ──
        console.log(`[${JOB_ID}] Uploading final video...`);
        const finalVideoBuffer = fs.readFileSync(finalOutputPath);

        const { error: uploadError } = await supabase.storage
            .from('pipeline_output')
            .upload(`${outputFolder}/final_video.mp4`, finalVideoBuffer, {
                contentType: 'video/mp4',
                upsert: true,
            });

        if (uploadError) {
            throw new Error(`Upload failed: ${uploadError.message}`);
        }

        // ── Step 8: Update job as complete ──
        await updateJob(JOB_ID, {
            status: 'complete',
            progress: 100,
            output_folder: outputFolder,
        });
        console.log(`[${JOB_ID}] ✅ Pipeline complete! Final video uploaded.`);

    } catch (err) {
        console.error(`[${JOB_ID}] Stitch error:`, err);
        await updateJob(JOB_ID, {
            status: 'error',
            error_message: `Stitching failed: ${err.message || String(err)}`,
        });
        process.exit(1);
    } finally {
        // Cleanup temp files
        try {
            fs.rmSync(workDir, { recursive: true, force: true });
        } catch (e) {
            console.warn('Cleanup error:', e);
        }
    }
}

main();
