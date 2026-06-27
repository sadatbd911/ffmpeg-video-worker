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

// ─────────────────────────────────────────────
// NEW: Generate Thumbnail via Pollinations AI
// ─────────────────────────────────────────────
app.post('/generate-thumbnail', async (req, res) => {
  const { title, description, characters, setting } = req.body;

  if (!title) return res.status(400).json({ error: 'Missing title' });

  // Build an attractive thumbnail prompt
  const prompt = `3D rendered children's YouTube thumbnail, Pixar Disney style 3D animation, 
    bedtime story: "${title}", 
    ${description ? `story about: "${description}",` : ''}
    cute 3D cartoon characters, magical glowing moonlight, 
    dreamy bedroom or fantasy landscape background, 
    sparkles and stars, soft warm lighting, 
    bold colorful text space at bottom, 
    ultra high quality 3D render, cinematic lighting, 
    professional YouTube thumbnail, 16:9 aspect ratio`;

  const encodedPrompt = encodeURIComponent(prompt.trim());
  const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1280&height=720&nologo=true&seed=${Date.now()}`;

  try {
    console.log(`[thumbnail] Generating for: ${title}`);
    const imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 60000 });
    const imgBase64 = Buffer.from(imgResp.data).toString('base64');
    const imgBuffer = Buffer.from(imgResp.data);

    console.log(`[thumbnail] Generated: ${(imgBuffer.length / 1024).toFixed(0)}KB`);

    res.json({
      success: true,
      thumbnail_base64: imgBase64,
      thumbnail_size_kb: (imgBuffer.length / 1024).toFixed(0),
      prompt_used: prompt.trim(),
      message: 'Thumbnail generated successfully!'
    });

  } catch (err) {
    console.error('[thumbnail] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// NEW: Upload Thumbnail to YouTube
// ─────────────────────────────────────────────
app.post('/upload-thumbnail', async (req, res) => {
  const { video_id, thumbnail_base64, access_token } = req.body;

  if (!video_id) return res.status(400).json({ error: 'Missing video_id' });
  if (!thumbnail_base64) return res.status(400).json({ error: 'Missing thumbnail_base64' });
  if (!access_token) return res.status(400).json({ error: 'Missing access_token' });

  try {
    console.log(`[upload-thumbnail] Uploading for video: ${video_id}`);

    const imgBuffer = Buffer.from(thumbnail_base64, 'base64');

    const response = await axios.post(
      `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${video_id}&uploadType=media`,
      imgBuffer,
      {
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'image/jpeg',
          'Content-Length': imgBuffer.length
        },
        timeout: 60000
      }
    );

    console.log(`[upload-thumbnail] Success for video: ${video_id}`);
    res.json({
      success: true,
      video_id: video_id,
      youtube_response: response.data,
      message: 'Thumbnail uploaded to YouTube successfully!'
    });

  } catch (err) {
    const errMsg = err.response?.data || err.message;
    console.error('[upload-thumbnail] Error:', JSON.stringify(errMsg));
    res.status(500).json({ error: errMsg });
  }
});

// ─────────────────────────────────────────────
// EXISTING: Assemble Video
// ─────────────────────────────────────────────
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
    const audioPath = path.join(jobDir, 'audio.mp3');
    if (audio_base64) {
      const audioBuffer = Buffer.from(audio_base64, 'base64');
      fs.writeFileSync(audioPath, audioBuffer);
      console.log(`[${jobId}] Audio saved: ${audioBuffer.length} bytes`);
    } else {
      const audioResp = await axios.get(audio_url, { responseType: 'arraybuffer' });
      fs.writeFileSync(audioPath, Buffer.from(audioResp.data));
    }

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

    const autoSceneDuration = Math.ceil(audioDuration / imagePaths.length);
    console.log(`[${jobId}] Scene duration: ${autoSceneDuration}s × ${imagePaths.length} scenes`);

    const listPath = path.join(jobDir, 'images.txt');
    let listContent = imagePaths.map(p => `file '${p}'\nduration ${autoSceneDuration}`).join('\n');
    listContent += `\nfile '${imagePaths[imagePaths.length - 1]}'`;
    fs.writeFileSync(listPath, listContent);

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
  console.log(`Generate thumbnail: POST /generate-thumbnail`);
  console.log(`Upload thumbnail: POST /upload-thumbnail`);
});
