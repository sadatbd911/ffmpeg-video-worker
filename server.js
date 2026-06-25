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
  let image_base64_list = req.body.image_base64_list;

  if (typeof image_urls === 'string') {
    try { image_urls = JSON.parse(image_urls); } catch(e) {}
  }
  if (typeof image_base64_list === 'string') {
    try { image_base64_list = JSON.parse(image_base64_list); } catch(e) {}
  }

  if (!audio_url && !audio_base64) {
    return res.status(400).json({ error: 'Missing audio_url or audio_base64' });
  }
  if ((!image_urls || image_urls.length === 0) && (!image_base64_list || image_base64_list.length === 0)) {
    return res.status(400).json({ error: 'Missing image_urls or image_base64_list' });
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

    // Step 2: Detect audio duration
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

    if (!audioDuration || audioDuration <= 0) {
      const audioSize = fs.statSync(audioPath).size;
      audioDuration = Math.round(audioSize / 16000);
      console.log(`[${jobId}] Size-based duration estimate: ${audioDuration}s`);
    }

    console.log(`[${jobId}] Final audio duration: ${audioDuration}s`);

    // Step 3: Save images (supports both base64 and URLs)
    const totalImages = image_base64_list ? image_base64_list.length : image_urls.length;
    console.log(`[${jobId}] Processing ${totalImages} images...`);

    const imagePaths = [];
    for (let i = 0; i < totalImages; i++) {
      const imgPath = path.join(jobDir, `scene_${String(i + 1).padStart(2, '0')}.jpg`);
      try {
        if (image_base64_list && image_base64_list[i]) {
          const imgBuffer = Buffer.from(image_base64_list[i], 'base64');
          fs.writeFileSync(imgPath, imgBuffer);
          console.log(`[${jobId}] Image ${i + 1}/${totalImages} saved from base64 (${(imgBuffer.length / 1024).toFixed(0)}KB)`);
        } else if (image_urls && image_urls[i]) {
          const imgResp = await axios.get(image_urls[i], { responseType: 'arraybuffer', timeout: 30000 });
          fs.writeFileSync(imgPath, Buffer.from(imgResp.data));
          console.log(`[${jobId}] Image ${i + 1}/${totalImages} downloaded from URL`);
        }
        imagePaths.push(imgPath);
      } catch (err) {
        console.log(`[${jobId}] Image ${i + 1} failed: ${err.message}`);
        if (imagePaths.length > 0) imagePaths.push(imagePaths[0]);
      }
      await new Promise(r => setTimeout(r, 100));
    }

    if (imagePaths.length === 0) throw new Error('No images downloaded');

    // Step 4: Calculate scene duration
    const autoSceneDuration = Math.ceil(audioDuration / imagePaths.length);
    console.log(`[${jobId}] Scene duration: ${autoSceneDuration}s × ${imagePaths.length} scenes`);

    // Step 5: Convert each image to a short video clip with dissolve transition
    const TRANSITION_DURATION = 1; // 1 second dissolve
    const clipPaths = [];

    console.log(`[${jobId}] Creating individual clips with dissolve...`);
    for (let i = 0; i < imagePaths.length; i++) {
      const clipPath = path.join(jobDir, `clip_${String(i + 1).padStart(2, '0')}.mp4`);
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(imagePaths[i])
          .inputOptions(['-loop 1'])
          .outputOptions([
            `-t ${autoSceneDuration}`,
            '-c:v libx264',
            '-preset fast',
            '-crf 23',
            '-pix_fmt yuv420p',
            '-vf scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1',
            '-r 25'
          ])
          .output(clipPath)
          .on('end', () => {
            clipPaths.push(clipPath);
            console.log(`[${jobId}] Clip ${i + 1}/${imagePaths.length} created`);
            resolve();
          })
          .on('error', reject)
          .run();
      });
    }

    // Step 6: Build xfade dissolve filter chain
    console.log(`[${jobId}] Building dissolve transition filter...`);
    const outputPath = path.join(jobDir, 'output.mp4');

    if (clipPaths.length === 1) {
      // Only one image — no transition needed
      const listPath = path.join(jobDir, 'images.txt');
      fs.writeFileSync(listPath, `file '${clipPaths[0]}'`);

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(clipPaths[0])
          .input(audioPath)
          .outputOptions([
            '-c:v libx264',
            '-preset fast',
            '-crf 23',
            '-pix_fmt yuv420p',
            '-c:a aac',
            '-b:a 128k',
            '-movflags +faststart',
            `-t ${audioDuration}`
          ])
          .output(outputPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

    } else {
      // Build xfade filter chain for dissolve transitions
      // Each clip overlaps by TRANSITION_DURATION seconds
      let filterComplex = '';
      let lastOutput = '[0:v]';

      for (let i = 1; i < clipPaths.length; i++) {
        const offset = (autoSceneDuration - TRANSITION_DURATION) * i;
        const currentOutput = i === clipPaths.length - 1 ? '[vout]' : `[v${i}]`;
        filterComplex += `${lastOutput}[${i}:v]xfade=transition=dissolve:duration=${TRANSITION_DURATION}:offset=${offset}${currentOutput}`;
        if (i < clipPaths.length - 1) filterComplex += '; ';
        lastOutput = currentOutput;
      }

      console.log(`[${jobId}] Filter: ${filterComplex}`);

      // Build ffmpeg command with all clips
      let cmd = ffmpeg();
      for (const clip of clipPaths) {
        cmd = cmd.input(clip);
      }
      cmd = cmd.input(audioPath);

      await new Promise((resolve, reject) => {
        cmd
          .complexFilter(filterComplex)
          .outputOptions([
            '-map [vout]',
            `-map ${clipPaths.length}:a`,
            '-c:v libx264',
            '-preset fast',
            '-crf 23',
            '-pix_fmt yuv420p',
            '-c:a aac',
            '-b:a 128k',
            '-movflags +faststart',
            `-t ${audioDuration}`
          ])
          .output(outputPath)
          .on('start', () => console.log(`[${jobId}] FFmpeg dissolve started`))
          .on('progress', p => console.log(`[${jobId}] Progress: ${Math.round(p.percent || 0)}%`))
          .on('end', () => { console.log(`[${jobId}] FFmpeg dissolve done!`); resolve(); })
          .on('error', (err) => { reject(err); })
          .run();
      });
    }

    const videoBuffer = fs.readFileSync(outputPath);
    const videoBase64 = videoBuffer.toString('base64');
    const videoSizeMb = (videoBuffer.length / 1024 / 1024).toFixed(2);

    console.log(`[${jobId}] Done! Size: ${videoSizeMb}MB`);

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
      message: 'Video assembled successfully with dissolve transitions!'
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
