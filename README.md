# FFmpeg Video Worker — Kids Story Channel

A simple Node.js + FFmpeg server that assembles images + audio into MP4 videos.
Designed to run FREE on Render.com.

## What it does
- Downloads 10 scene images from Pollinations AI
- Downloads narration audio from ElevenLabs
- Assembles them into a 1280x720 MP4 slideshow
- Returns the video as base64 for n8n to handle

## Deploy to Render.com (free)
1. Push this folder to a GitHub repo
2. Go to render.com → New Web Service
3. Connect your GitHub repo
4. Build command: `apt-get update && apt-get install -y ffmpeg && npm install`
5. Start command: `node server.js`
6. Plan: Free
7. Click Deploy!

## API Usage

### Health Check
GET /

### Assemble Video
POST /assemble-video
Content-Type: application/json

{
  "story_id": "unique_story_id",
  "title": "Luna's Little Light",
  "audio_url": "https://...",
  "image_urls": [
    "https://image.pollinations.ai/...",
    "https://image.pollinations.ai/...",
    ...10 urls total
  ],
  "scene_duration": 5
}

### Response
{
  "success": true,
  "job_id": "...",
  "title": "Luna's Little Light",
  "video_size_mb": "12.5",
  "video_base64": "base64_encoded_mp4...",
  "message": "Video assembled successfully!"
}
