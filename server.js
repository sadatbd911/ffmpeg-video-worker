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

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'FFmpeg Video Worker is running!' });
});

app.post('/assemble-video', async (req, res) => {
  console.log('Request received!');
  console.log('Body keys:', Object.keys(req.body));

  const { story_id, title, scene_duration = 5 } = req.body;
  let audio_url = req.body.audio_url;
  let audio_base64 = req.body.audio_base64;
  let image_urls = req.body.image_urls;

  if (typeof image_urls === 'string') {
    try { image_urls = JSON.parse(image_urls); } catch(e) {}
  }

  if (!audio_url && !audio_base64) {
    return res.status(400).json({ error: 'Missing audio_url or audio_base64' });
  }
  if (!image_urls || image_urls.length === 0) {
    return res.status(400).json({ error: 'Missing image_urls' });
  }

  const jobId = story_id || Date.now().toString();
  const jobDir = path.join(TMP, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  console.log(`[${jobId}] Starting for: ${title}`);

  try {
    // Step 1: Save audio
    const audioPath = path.join(jobDir, 'audio.mp3');
    if (audio_base64) {
      const audioBuffer = Buffer.from(audio_base64, 'base64');
      fs.writeFileSync(audioPath, audioBuffer);
      console.log(`[${jobId}] Audio saved: ${audioBuffer.length} bytes`);
    } else {
      const audioResp = await axios.get(audio_url, { responseType: 'arraybuffer' });
      fs.writeFileSync(audioPath, Buffer.from(audioResp.data));
    }

    // Step 2: Detect audio duration using fluent-ffmpeg's ffprobe
    let audioDuration = 0;
    try {
      audioDuration = await new Promise((resolve) => {
        ffmpeg.ffprobe(audioPath, (err, metadata) => {
          if (err) {
            console.log(`[${jobId}] ffprobe error: ${err.message}`);
            resolve(0);
          } else {
            const dur = metadata.format.duration;
            console.log(`[${jobId}] ffprobe duration: ${dur}s`);
            resolve(dur || 0);
          }
        });
      });
    } catch(e) {
      console.log(`[${jobId}] ffprobe failed: ${e.message}`);
    }

    // Fallback: estimate from file size if ffprobe fails
    // MPGA/MP3 at 128kbps = ~16KB per second
    if (!audioDuration || audioDuration <= 0) {
      const audioSize = fs.statSync(audioPath).size;
      audioDuration = Math.round(audioSize / 16000);
      console.log(`[${jobId}] Size-based duration estimate: ${audioDuration}s (file: ${audioSize} bytes)`);
    }

    console.log(`[${jobId}] Final audio duration: ${audioDuration}s`);

    // Step 3: Download images
    console.log(`[${jobId}] Downloading ${image_urls.length} images...`);
    const imagePaths = [];
    for (let i = 0; i < image_urls.length; i++) {
      const imgPath = path.join(jobDir, `scene_${String(i + 1).padStart(2, '0')}.jpg`);
      try {
        const imgResp = await axios.get(image_urls[i], { responseType: 'arraybuffer', timeout: 30000 });
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

    // Step 4: Calculate scene duration from actual audio
    const autoSceneDuration = Math.ceil(audioDuration / imagePaths.length);
    console.log(`[${jobId}] Scene duration: ${autoSceneDuration}s × ${imagePaths.length} scenes = ${autoSceneDuration * imagePaths.length}s total`);

    // Step 5: Create image list
    const listPath = path.join(jobDir, 'images.txt');
    let listContent = imagePaths.map(p => `file '${p}'\nduration ${autoSceneDuration}`).join('\n');
    listContent += `\nfile '${imagePaths[imagePaths.length - 1]}'`;
    fs.writeFileSync(listPath, listContent);

    // Step 6: FFmpeg assembly
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
        .on('error', (err) => { reject(err); })
        .run();
    });

    const videoBuffer = fs.readFileSync(outputPath);
    const videoBase64 = videoBuffer.toString('base64');
    const videoSizeMb = (videoBuffer.length / 1024 / 1024).toFixed(2);

    console.log(`[${jobId}] Done! Size: ${videoSizeMb}MB, Audio: ${audioDuration}s, Video: ${autoSceneDuration * imagePaths.length}s`);

    fs.rmSync(jobDir, { recursive: true, force: true });

    res.json({
      success: true,
      job_id: jobId,
      title: title,
      video_size_mb: videoSizeMb,
      audio_duration_seconds: Math.round(audioDuration),
      scene_duration_seconds: autoSceneDuration,
      total_video_seconds: autoSceneDuration * imagePaths.length,
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
