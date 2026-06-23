const express = require('express');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const TMP = '/tmp/story_worker';

// Create temp directory
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'FFmpeg Video Worker is running!' });
});

// ─── Main video assembly endpoint ────────────────────────────────────────────
// POST /assemble-video
// Body: {
//   story_id: "unique_id",
//   audio_url: "https://...",   ← ElevenLabs audio URL
//   image_urls: ["https://...", ...],  ← 10 Pollinations image URLs
//   scene_duration: 5,          ← seconds per image (default 5)
//   title: "Story title"
// }
app.post('/assemble-video', async (req, res) => {
  const { story_id, audio_url, image_urls, scene_duration = 5, title } = req.body;

  if (!audio_url || !image_urls || image_urls.length === 0) {
    return res.status(400).json({ error: 'Missing audio_url or image_urls' });
  }

  const jobId = story_id || Date.now().toString();
  const jobDir = path.join(TMP, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  console.log(`[${jobId}] Starting video assembly for: ${title}`);

  try {
    // ── Step 1: Download audio ──────────────────────────────────────────────
    console.log(`[${jobId}] Downloading audio...`);
    const audioPath = path.join(jobDir, 'audio.mp3');
    const audioResp = await axios.get(audio_url, { responseType: 'arraybuffer' });
    fs.writeFileSync(audioPath, Buffer.from(audioResp.data));
    console.log(`[${jobId}] Audio downloaded: ${fs.statSync(audioPath).size} bytes`);

    // ── Step 2: Download all images ─────────────────────────────────────────
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
        console.log(`[${jobId}] Image ${i + 1}/${image_urls.length} downloaded`);
      } catch (err) {
        console.log(`[${jobId}] Image ${i + 1} failed, using placeholder`);
        // Create a simple placeholder if image fails
        imagePaths.push(imagePaths[0] || imgPath);
      }
      // Small delay between image downloads
      await new Promise(r => setTimeout(r, 500));
    }

    // ── Step 3: Create image list file for FFmpeg ───────────────────────────
    const listPath = path.join(jobDir, 'images.txt');
    const listContent = imagePaths.map(p =>
      `file '${p}'\nduration ${scene_duration}`
    ).join('\n');
    // Add last image again (FFmpeg concat requires it)
    const lastImg = imagePaths[imagePaths.length - 1];
    fs.writeFileSync(listPath, listContent + `\nfile '${lastImg}'`);

    // ── Step 4: Assemble video with FFmpeg ──────────────────────────────────
    console.log(`[${jobId}] Assembling video with FFmpeg...`);
    const outputPath = path.join(jobDir, 'output.mp4');

    await new Promise((resolve, reject) => {
      ffmpeg()
        // Input 1: slideshow from images
        .input(listPath)
        .inputOptions([
          '-f concat',
          '-safe 0'
        ])
        // Input 2: audio
        .input(audioPath)
        // Video settings
        .outputOptions([
          '-c:v libx264',
          '-preset fast',
          '-crf 23',
          '-pix_fmt yuv420p',
          '-vf scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1',
          '-c:a aac',
          '-b:a 128k',
          '-shortest',        // stop when shortest input ends
          '-movflags +faststart'
        ])
        .output(outputPath)
        .on('start', cmd => console.log(`[${jobId}] FFmpeg started`))
        .on('progress', p => console.log(`[${jobId}] Progress: ${Math.round(p.percent || 0)}%`))
        .on('end', () => {
          console.log(`[${jobId}] Video assembled successfully!`);
          resolve();
        })
        .on('error', (err) => {
          console.error(`[${jobId}] FFmpeg error:`, err.message);
          reject(err);
        })
        .run();
    });

    // ── Step 5: Return video as base64 ──────────────────────────────────────
    const videoBuffer = fs.readFileSync(outputPath);
    const videoBase64 = videoBuffer.toString('base64');
    const videoSize = fs.statSync(outputPath).size;

    console.log(`[${jobId}] Done! Video size: ${(videoSize / 1024 / 1024).toFixed(2)} MB`);

    // Cleanup job directory
    fs.rmSync(jobDir, { recursive: true, force: true });

    res.json({
      success: true,
      job_id: jobId,
      title: title,
      video_size_mb: (videoSize / 1024 / 1024).toFixed(2),
      video_base64: videoBase64,
      message: 'Video assembled successfully!'
    });

  } catch (err) {
    console.error(`[${jobId}] Error:`, err.message);
    // Cleanup on error
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (e) {}
    res.status(500).json({ error: err.message });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`FFmpeg Video Worker running on port ${PORT}`);
  console.log(`Health check: GET /`);
  console.log(`Assemble video: POST /assemble-video`);
});
