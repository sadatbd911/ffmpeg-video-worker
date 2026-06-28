const express = require('express');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { exec } = require('child_process');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
app.use(cors());
app.use(express.json({ limit: '200mb' }));

const PORT = process.env.PORT || 3000;
const TMP = '/tmp/story_worker';
const MUSIC_DIR = path.join(__dirname, 'music');

if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

// Music mood mapping
const MUSIC_FILES = {
  'soft_lullaby': 'soft_lullaby.mp3',
  'adventure': 'adventure.mp3',
  'magical': 'magical.mp3',
  'ocean': 'ocean.mp3',
  'space': 'space.mp3'
};

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'FFmpeg Video Worker is running!' });
});

app.post('/assemble-video', async (req, res) => {
  console.log('Request received!');

  const { story_id, title, music_mood } = req.body;
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
  console.log(`[${jobId}] Starting: ${title}, music_mood: ${music_mood}`);

  try {
    // Step 1: Save voice audio
    const voicePath = path.join(jobDir, 'voice.mp3');
    if (audio_base64) {
      fs.writeFileSync(voicePath, Buffer.from(audio_base64, 'base64'));
    } else {
      const r = await axios.get(audio_url, { responseType: 'arraybuffer' });
      fs.writeFileSync(voicePath, Buffer.from(r.data));
    }

    // Step 2: Mix music with voice (if music_mood provided)
    let audioPath = voicePath;
    const musicFile = music_mood && MUSIC_FILES[music_mood]
      ? path.join(MUSIC_DIR, MUSIC_FILES[music_mood])
      : null;

    if (musicFile && fs.existsSync(musicFile)) {
      console.log(`[${jobId}] Mixing music: ${music_mood}`);
      const mixedPath = path.join(jobDir, 'audio.mp3');

      await new Promise((resolve, reject) => {
        // Mix: voice 100% + music 20% looped, cut to voice length
        const mixCmd = `${ffmpegInstaller.path} -i "${voicePath}" -stream_loop -1 -i "${musicFile}" -filter_complex "[0:a]volume=1.0[voice];[1:a]volume=0.20[music];[voice][music]amix=inputs=2:duration=first:dropout_transition=2[aout]" -map "[aout]" -c:a aac -b:a 128k "${mixedPath}" -y`;

        exec(mixCmd, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
          if (err) {
            console.log(`[${jobId}] Music mix failed, using voice only: ${err.message}`);
            audioPath = voicePath; // fallback to voice only
            resolve();
          } else {
            console.log(`[${jobId}] Music mixed successfully!`);
            audioPath = mixedPath;
            resolve();
          }
        });
      });
    } else {
      console.log(`[${jobId}] No music file found for mood: ${music_mood}, using voice only`);
      audioPath = voicePath;
    }

    // Step 3: Get audio duration
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

    // Step 4: Save images
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

    if (n === 1) {
      await new Promise((resolve, reject) => {
        const cmd = `${ffmpegInstaller.path} -loop 1 -t ${audioDuration} -i "${imagePaths[0]}" -i "${audioPath}" -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1" -c:a aac -b:a 128k -shortest -movflags +faststart "${outputPath}" -y`;
        exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
          if (err) reject(new Error(stderr.slice(-300)));
          else resolve();
        });
      });
    } else {
      await new Promise((resolve, reject) => {
        // Build input args
        let inputArgs = imagePaths.map(p => `-loop 1 -t ${autoSceneDuration} -i "${p}"`).join(' ');
        inputArgs += ` -i "${audioPath}"`;

        // Build filter_complex
        let fc = '';
        for (let i = 0; i < n; i++) {
          fc += `[${i}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${i}];`;
        }
        for (let i = 0; i < n - 1; i++) {
          const inA = i === 0 ? `[v0]` : `[xf${i-1}]`;
          const inB = `[v${i+1}]`;
          const outLabel = i === n - 2 ? `[vout]` : `[xf${i}]`;
          const offset = (autoSceneDuration - fadeDuration) * (i + 1);
          fc += `${inA}${inB}xfade=transition=dissolve:duration=${fadeDuration}:offset=${offset.toFixed(3)}${outLabel}`;
          if (i < n - 2) fc += ';';
        }

        const cmd = `${ffmpegInstaller.path} ${inputArgs} -filter_complex "${fc}" -map "[vout]" -map "${n}:a" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -shortest -movflags +faststart "${outputPath}" -y`;

        console.log(`[${jobId}] Running FFmpeg xfade dissolve...`);
        exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
          if (err) {
            console.error(`[${jobId}] FFmpeg error:`, stderr.slice(-500));
            reject(new Error(stderr.slice(-300)));
          } else {
            console.log(`[${jobId}] FFmpeg done!`);
            resolve();
          }
        });
      });
    }

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
      music_mood: music_mood || 'none',
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
