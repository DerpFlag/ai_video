// ============================================================
// AI Video Stitcher Service
// Deploy on Render.com (free tier) or any Node.js host
//
// This service:
//   1. Downloads all video + audio segments from Supabase Storage
//   2. Concatenates videos with ffmpeg
//   3. Concatenates audio voiceovers
//   4. Gets durations of both
//   5. Adjusts video speed to match audio duration
//   6. Mixes: video audio at 30% + voiceover at 100%
//   7. Uploads final video to Supabase Storage
//   8. Updates job status in Supabase DB
// ============================================================

const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(express.json());

// ── Config ──
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://acpxzjrjhvvnwnqzgbxk.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const PORT = process.env.PORT || 3001;

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

// ── Main Stitch Endpoint ──
app.post('/stitch', async (req, res) => {
    const { job_id, segment_count } = req.body;
    if (!job_id || !segment_count) {
        return res.status(400).json({ error: 'Missing job_id or segment_count' });
    }

    // Respond immediately — process in background
    res.json({ success: true, message: 'Stitching started' });

    const workDir = path.join('/tmp', `stitch_${job_id}`);
    try {
        // Create work directory
        fs.mkdirSync(workDir, { recursive: true });
        const outputFolder = `job_${job_id}`;

        await updateJob(job_id, { status: 'stitching', progress: 96 });

        // ── Step 1: Download all segments ──
        console.log(`[${job_id}] Downloading ${segment_count} video + audio segments...`);

        const videoFiles = [];
        const audioFiles = [];

        for (let i = 1; i <= segment_count; i++) {
            const videoPath = path.join(workDir, `video_${i}.mp4`);
            const audioPath = path.join(workDir, `voice_${i}.mp3`);

            const videoUrl = `${SUPABASE_URL}/storage/v1/object/public/pipeline_output/${outputFolder}/videos/video_${i}.mp4`;
            const audioUrl = `${SUPABASE_URL}/storage/v1/object/public/pipeline_output/${outputFolder}/audio/voice_${i}.mp3`;

            try {
                await downloadFile(videoUrl, videoPath);
                videoFiles.push(videoPath);
            } catch (e) {
                console.warn(`[${job_id}] Video segment ${i} not found, skipping`);
            }

            try {
                await downloadFile(audioUrl, audioPath);
                audioFiles.push(audioPath);
            } catch (e) {
                console.warn(`[${job_id}] Audio segment ${i} not found, skipping`);
            }
        }

        if (videoFiles.length === 0) {
            await updateJob(job_id, { status: 'error', error_message: 'No video segments found to stitch' });
            return;
        }

        // ── Step 2: Concatenate all videos ──
        console.log(`[${job_id}] Concatenating ${videoFiles.length} videos...`);
        const concatVideoPath = path.join(workDir, 'concat_video.mp4');

        // Create concat list file
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
            console.log(`[${job_id}] Concatenating ${audioFiles.length} audio files...`);
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

        console.log(`[${job_id}] Video duration: ${videoDuration.toFixed(2)}s, Audio duration: ${audioDuration.toFixed(2)}s`);

        // ── Step 5: Speed-adjust video to match audio ──
        let adjustedVideoPath = concatVideoPath;
        if (Math.abs(videoDuration - audioDuration) > 0.5 && concatAudioPath) {
            console.log(`[${job_id}] Adjusting video speed to match audio...`);
            adjustedVideoPath = path.join(workDir, 'adjusted_video.mp4');

            // Speed factor: if video is 30s and audio is 25s, we speed up video by 30/25 = 1.2x
            // PTS manipulation: setpts=PTS*(audioDuration/videoDuration)
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
            console.log(`[${job_id}] Mixing audio: video at 30%, voiceover at 100%...`);

            // Use complex filter to mix audio streams
            // [0:a] = video's original audio (volume 0.3)
            // [1:a] = voiceover audio (volume 1.0)
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
            // No voiceover — just copy the video
            fs.copyFileSync(adjustedVideoPath, finalOutputPath);
        }

        // ── Step 7: Upload final video to Supabase Storage ──
        console.log(`[${job_id}] Uploading final video...`);
        const finalVideoBuffer = fs.readFileSync(finalOutputPath);

        const { error: uploadError } = await supabase.storage
            .from('pipeline_output')
            .upload(`${outputFolder}/final_video.mp4`, finalVideoBuffer, {
                contentType: 'video/mp4',
                upsert: true,
            });

        if (uploadError) {
            console.error(`[${job_id}] Upload error:`, uploadError);
            await updateJob(job_id, { status: 'error', error_message: `Upload failed: ${uploadError.message}` });
        } else {
            // ── Step 8: Update job as complete ──
            await updateJob(job_id, {
                status: 'complete',
                progress: 100,
                output_folder: outputFolder,
            });
            console.log(`[${job_id}] ✅ Pipeline complete! Final video uploaded.`);
        }
    } catch (err) {
        console.error(`[${job_id}] Stitch error:`, err);
        await updateJob(job_id, {
            status: 'error',
            error_message: `Stitching failed: ${err.message || String(err)}`,
        });
    } finally {
        // Cleanup temp files
        try {
            fs.rmSync(workDir, { recursive: true, force: true });
        } catch (e) {
            console.warn('Cleanup error:', e);
        }
    }
});

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'AI Video Stitcher' });
});

app.listen(PORT, () => {
    console.log(`🎬 Stitcher service running on port ${PORT}`);
});
