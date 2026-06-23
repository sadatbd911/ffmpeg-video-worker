const express = require('express');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { execSync } = require('child_process');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
app.use(cors());
app.use(express.json({ limit: '200mb' }));

const PORT = process.env.PORT || 3000;
const TMP = '/tmp/story_worker';

if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'FFmpeg Video Worker is running!' });
});

// Assemble video endpoint
app.post('/assemble-video', async (req, res) => {
  console.log('Request received!');
  console.log('Body keys:', Object.keys(req.body));

  const { story_id, title, scene_duration = 5 } = req.body;

  let audio_url = req.body.audio_url;
  let audio_base64 = req.body.audio_base64;

  let image_urls = req.body.image_urls;
  if (typeof image_urls === 'string') {
    try { image_urls = JSON.parse(image_urls); } catch(e) {
      console.log('Failed to parse image_urls:', e.message);
    }
  }

  console.log('audio_base64:', audio_base64 ? `present (${audio_base64.length} chars)` : 'missing');
  console.log('image_urls:', image_urls ? `${image_urls.length} URLs` : 'missing');

  if (!audio_url && !audio_base64) {
    return res.status(400).json({ error: 'Missing audio_url or audio_base64' });
  }
  if (!image_urls || image_urls.length === 0) {
    return res.status(400).json({ error: 'Missing image_urls' });
  }

  const jobId = story_id || Date.now().toString();
  const jobDir = path.join(TMP, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  console.log(`[${jobId}] Starting video assembly for: ${title}`);

  try {
    // Step 1: Save audio
    const audioPath = path.join(jobDir, 'audio.mp3');

    if (audio_base64) {
      console.log(`[${jobId}] Using base64 audio...`);
      const audioBuffer = Buffer.from(audio_base64, 'base64');
      fs.writeFileSync(audioPath, audioBuffer);
      console.log(`[${jobId}] Audio saved: ${audioBuffer.length} bytes`);
    } else {
      console.log(`[${jobId}] Downloading audio from URL...`);
      const audioResp = await axios.get(audio_url, { responseType: 'arraybuffer' });
      fs.writeFileSync(audioPath, Buffer.from(audioResp.data));
      console.log(`[${jobId}] Audio downloaded: ${fs.statSync(audioPath).size} bytes`);
    }

    // Step 2: Get actual audio duration
    let audioDuration = 180; // default 3 minutes
    try {
      const ffprobePath = ffmpegInstaller.path.replace('ffmpeg', 'ffprobe');
      const result = execSync(
        `"${ffprobePath}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
      );
      audioDuration = parseFloat(result.toString().trim());
      console.log(`[${jobId}] Audio duration: ${audioDuration} seconds`);
    } catch(e) {
      console.log(`[${jobId}] Could not detect audio duration, using default ${audioDuration}s`);
    }

    // Step 3: Download images
    console.log(`[${jobId}] Downloading ${image_urls.length} images...`);
    const imagePaths = [];

    for (let i = 0; i < image_urls.length; i++) {
      const imgPath = path.join(jobDir, `scene_${String(i + 1).padStart(2, '0')}.jpg`);
      try {
        const imgResp = await axios.get(image_urls[i], {
          responseType: 'arraybuffer',
          timeout: 30000
        });
        fs.writeFileSync(imgPath, Buffer.from(imgResp.data));
        imagePaths.push(imgPath);
        console.log(`[${jobId}] Image ${i + 1}/${image_urls.length} done`);
      } catch (err) {
        console.log(`[${jobId}] Image ${i + 1} failed: ${err.message}`);
        if (imagePaths.length > 0) imagePaths.push(imagePaths[0]);
      }
      await new Promise(r => setTimeout(r, 300));
    }

    if (imagePaths.length === 0) throw new Error('No images downloaded');

    // Step 4: Calculate scene duration from audio length
    const autoSceneDuration = Math.ceil(audioDuration / imagePaths.length);
    console.log(`[${jobId}] Auto scene duration: ${autoSceneDuration}s per scene`);

    // Step 5: Create image list for FFmpeg
    const listPath = path.join(jobDir, 'images.txt');
    let listContent = imagePaths.map(p =>
      `file '${p}'\nduration ${autoSceneDuration}`
    ).join('\n');
    // Add last image again (FFmpeg concat requirement)
    listContent += `\nfile '${imagePaths[imagePaths.length - 1]}'`;
    fs.writeFileSync(listPath, listContent);
    console.log(`[${jobId}] Image list created`);

    // Step 6: Assemble with FFmpeg
    console.log(`[${jobId}] Running FFmpeg...`);
    const outputPath = path.join(jobDir, 'output.mp4');

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(listPath)
        .inputOptions(['-f concat', '-safe 0'])
        .input(audioPath)
        .outputOptions([
          '-c:v libx264',
          '-preset fast',
          '-crf 23',
          '-pix_fmt yuv420p',
          '-vf scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1',
          '-c:a aac',
          '-b:a 128k',
          '-movflags +faststart'
        ])
        .output(outputPath)
        .on('start', () => console.log(`[${jobId}] FFmpeg started`))
        .on('progress', p => console.log(`[${jobId}] Progress: ${Math.round(p.percent || 0)}%`))
        .on('end', () => { console.log(`[${jobId}] FFmpeg done!`); resolve(); })
        .on('error', (err) => { console.error(`[${jobId}] FFmpeg error:`, err.message); reject(err); })
        .run();
    });

    // Step 7: Return video as base64
    const videoBuffer = fs.readFileSync(outputPath);
    const videoBase64 = videoBuffer.toString('base64');
    const videoSizeMb = (videoBuffer.length / 1024 / 1024).toFixed(2);
    const totalDuration = autoSceneDuration * imagePaths.length;

    console.log(`[${jobId}] Done! Size: ${videoSizeMb} MB, Duration: ~${totalDuration}s`);

    // Cleanup
    fs.rmSync(jobDir, { recursive: true, force: true });

    res.json({
      success: true,
      job_id: jobId,
      title: title,
      video_size_mb: videoSizeMb,
      audio_duration_seconds: audioDuration,
      scene_duration_seconds: autoSceneDuration,
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
  console.log(`Health check: GET /`);
  console.log(`Assemble video: POST /assemble-video`);
});
