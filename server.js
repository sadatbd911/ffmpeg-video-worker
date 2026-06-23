const express = require('express');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
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

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'FFmpeg Video Worker is running!' });
});

// Assemble video endpoint
app.post('/assemble-video', async (req, res) => {
  console.log('Request received!');
  console.log('Body keys:', Object.keys(req.body));

  const { story_id, title, scene_duration = 5 } = req.body;

  // Handle audio - either URL or base64
  let audio_url = req.body.audio_url;
  let audio_base64 = req.body.audio_base64;

  // Handle image_urls - either array or JSON string
  let image_urls = req.body.image_urls;
  if (typeof image_urls === 'string') {
    try { image_urls = JSON.parse(image_urls); } catch(e) {
      console.log('Failed to parse image_urls string:', e.message);
    }
  }

  console.log('audio_url:', audio_url ? 'present' : 'missing');
  console.log('audio_base64:', audio_base64 ? `present (${audio_base64.length} chars)` : 'missing');
  console.log('image_urls:', image_urls ? `${image_urls.length} URLs` : 'missing');

  // Validate
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

    // Step 2: Download images
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
        if (imagePaths.length > 0) {
          imagePaths.push(imagePaths[0]);
        }
      }
      await new Promise(r => setTimeout(r, 300));
    }

    if (imagePaths.length === 0) {
      throw new Error('No images downloaded successfully');
    }

    // Step 3: Create image list for FFmpeg
    const listPath = path.join(jobDir, 'images.txt');
    let listContent = imagePaths.map(p => `file '${p}'\nduration ${scene_duration}`).join('\n');
    listContent += `\nfile '${imagePaths[imagePaths.length - 1]}'`;
    fs.writeFileSync(listPath, listContent);
    console.log(`[${jobId}] Image list created with ${imagePaths.length} images`);

    // Step 4: Assemble with FFmpeg
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
          '-shortest',
          '-movflags +faststart'
        ])
        .output(outputPath)
        .on('start', () => console.log(`[${jobId}] FFmpeg started`))
        .on('progress', p => console.log(`[${jobId}] Progress: ${Math.round(p.percent || 0)}%`))
        .on('end', () => { console.log(`[${jobId}] FFmpeg done!`); resolve(); })
        .on('error', (err) => { console.error(`[${jobId}] FFmpeg error:`, err.message); reject(err); })
        .run();
    });

    // Step 5: Return video as base64
    const videoBuffer = fs.readFileSync(outputPath);
    const videoBase64 = videoBuffer.toString('base64');
    const videoSizeMb = (videoBuffer.length / 1024 / 1024).toFixed(2);

    console.log(`[${jobId}] Done! Size: ${videoSizeMb} MB`);

    // Cleanup
    fs.rmSync(jobDir, { recursive: true, force: true });

    res.json({
      success: true,
      job_id: jobId,
      title: title,
      video_size_mb: videoSizeMb,
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
