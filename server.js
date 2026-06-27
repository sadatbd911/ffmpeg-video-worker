const express = require('express');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
app.use(cors());
app.use(express.json({ limit: '200mb' }));

const PORT = process.env.PORT || 3000;
const TMP = '/tmp/story_worker';

if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'FFmpeg Video Worker is running!' });
});

app.post('/assemble-video', async (req, res) => {
  console.log('Request received!');

  const { story_id, title } = req.body;
  let audio_url = req.body.audio_url;
  let audio_base64 = req.body.audio_base64;
  let image_urls = req.body.image_urls;
  let image_base64_list = req.body.image_base64_list;

  if (typeof image_urls === 'string') { try { image_urls = JSON.parse(image_urls); } catch(e) {} }
  if (typeof image_base64_list === 'string') { try { image_base64_list = JSON.parse(image_base64_list); } catch(e) {} }

  if (!audio_url && !audio_base64) return res.status(400).json({ error: 'Missing audio' });
  if ((!image_urls || !image_urls.length) && (!image_base64_list || !image_base64_list.length))
    return res.status(400).json({ error: 'Missing images' });

  const jobId = story_id || Date.now().toString();
  const jobDir = path.join(TMP, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  console.log(`[${jobId}] Starting: ${title}`);

  try {
    // Save audio
    const audioPath = path.join(jobDir, 'audio.mp3');
    if (audio_base64) {
      fs.writeFileSync(audioPath, Buffer.from(audio_base64, 'base64'));
    } else {
      const r = await axios.get(audio_url, { responseType: 'arraybuffer' });
      fs.writeFileSync(audioPath, Buffer.from(r.data));
    }

    // Get audio duration
    let audioDuration = 0;
    try {
      audioDuration = await new Promise((resolve) => {
        ffmpeg.ffprobe(audioPath, (err, meta) => {
          if (err) resolve(0);
          else resolve(meta.format.duration || 0);
        });
      });
    } catch(e) {}
    if (!audioDuration || audioDuration <= 0) {
      audioDuration = Math.round(fs.statSync(audioPath).size / 16000);
    }
    console.log(`[${jobId}] Audio: ${audioDuration.toFixed(2)}s`);

    // Save images
    const total = image_base64_list ? image_base64_list.length : image_urls.length;
    const imagePaths = [];
    for (let i = 0; i < total; i++) {
      const p = path.join(jobDir, `scene_${String(i+1).padStart(2,'0')}.jpg`);
      try {
        if (image_base64_list && image_base64_list[i]) {
          fs.writeFileSync(p, Buffer.from(image_base64_list[i], 'base64'));
        } else {
          const r = await axios.get(image_urls[i], { responseType: 'arraybuffer', timeout: 30000 });
          fs.writeFileSync(p, Buffer.from(r.data));
        }
        imagePaths.push(p);
        console.log(`[${jobId}] Image ${i+1}/${total} saved`);
      } catch(e) {
        console.log(`[${jobId}] Image ${i+1} failed: ${e.message}`);
        if (imagePaths.length > 0) imagePaths.push(imagePaths[0]);
      }
      await new Promise(r => setTimeout(r, 100));
    }
    if (!imagePaths.length) throw new Error('No images');

    const n = imagePaths.length;
    const fadeDuration = 1;
    const autoSceneDuration = Math.max(audioDuration / n, fadeDuration * 3);
    console.log(`[${jobId}] ${n} scenes x ${autoSceneDuration.toFixed(2)}s, fade ${fadeDuration}s`);

    const outputPath = path.join(jobDir, 'output.mp4');
    const ffmpegBin = ffmpegInstaller.path;

    // Build ffmpeg command as raw string — most reliable approach
    // Each image as separate -loop 1 -t N -i input
    let inputArgs = [];
    imagePaths.forEach(p => {
      inputArgs.push(`-loop 1 -t ${autoSceneDuration} -i "${p}"`);
    });
    inputArgs.push(`-i "${audioPath}"`);

    // Build filter_complex string
    let fc = '';
    // Scale all
    for (let i = 0; i < n; i++) {
      fc += `[${i}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${i}];`;
    }
    // xfade chain
    if (n === 1) {
      fc += `[v0]copy[vout]`;
    } else {
      for (let i = 0; i < n - 1; i++) {
        const inA = i === 0 ? `[v0]` : `[xf${i-1}]`;
        const inB = `[v${i+1}]`;
        const outLabel = i === n - 2 ? `[vout]` : `[xf${i}]`;
        const offset = (autoSceneDuration - fadeDuration) * (i + 1);
        fc += `${inA}${inB}xfade=transition=dissolve:duration=${fadeDuration}:offset=${offset.toFixed(3)}${outLabel}`;
        if (i < n - 2) fc += ';';
      }
    }

    console.log(`[${jobId}] filter_complex length: ${fc.length} chars`);

    const cmd = `${ffmpegBin} ${inputArgs.join(' ')} -filter_complex "${fc.replace(/"/g, '\\"')}" -map "[vout]" -map "${n}:a" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -shortest -movflags +faststart "${outputPath}"`;

    console.log(`[${jobId}] Running FFmpeg...`);
    await new Promise((resolve, reject) => {
      const { exec } = require('child_process');
      exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
        if (err) {
          console.error(`[${jobId}] FFmpeg error:`, stderr.slice(-500));
          reject(new Error(stderr.slice(-300)));
        } else {
          console.log(`[${jobId}] FFmpeg done!`);
          resolve();
        }
      });
    });

    const videoBuffer = fs.readFileSync(outputPath);
    const videoBase64 = videoBuffer.toString('base64');
    const sizeMb = (videoBuffer.length / 1024 / 1024).toFixed(2);
    console.log(`[${jobId}] Size: ${sizeMb}MB`);
    fs.rmSync(jobDir, { recursive: true, force: true });

    res.json({
      success: true, job_id: jobId, title,
      video_size_mb: sizeMb,
      audio_duration_seconds: Math.round(audioDuration),
      scene_duration_seconds: parseFloat(autoSceneDuration.toFixed(2)),
      video_base64: videoBase64,
      message: 'Video assembled successfully!'
    });

  } catch (err) {
    console.error(`[${jobId}] Error:`, err.message);
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch(e) {}
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`FFmpeg Video Worker running on port ${PORT}`);
});
