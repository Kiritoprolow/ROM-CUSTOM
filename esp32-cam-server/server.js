"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const express = require("express");
const { WebSocketServer } = require("ws");
const axios = require("axios");
const FormData = require("form-data");
const sharp = require("sharp");

sharp.concurrency(1); // keep image work off the ffmpeg core and predictable

// TEST MẠNG - XOÁ SAU KHI DEBUG XONG
axios.get('https://api.telegram.org', { timeout: 10000 })
  .then(r => console.log('[NETWORK TEST] Telegram OK, status:', r.status))
  .catch(e => console.log('[NETWORK TEST] Telegram FAILED:', e.code || e.message));

axios.get('https://huggingface.co', { timeout: 10000 })
  .then(r => console.log('[NETWORK TEST] HuggingFace OK, status:', r.status))
  .catch(e => console.log('[NETWORK TEST] HuggingFace FAILED:', e.code || e.message));

axios.get('https://pixeldrain.com', { timeout: 10000 })
  .then(r => console.log('[NETWORK TEST] PixelDrain OK, status:', r.status))
  .catch(e => console.log('[NETWORK TEST] PixelDrain FAILED:', e.code || e.message));

const PORT = parseInt(process.env.PORT || "7860", 10);
const API_KEY = process.env.API_KEY || "";
const GRADIO_SPACE =
  process.env.GRADIO_SPACE || "Kakaytbrr/vuon-sau-rieng-face-detect";
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const CHAT_ID = (process.env.CHAT_ID || "").trim();
// Telegram API base URL; point to a Cloudflare Worker relay
// (see cloudflare-worker/telegram-relay.js) when the host blocks api.telegram.org
const TELEGRAM_API_BASE = (
  process.env.TELEGRAM_API_BASE || "https://api.telegram.org"
).replace(/\/+$/, "");
const RELAY_KEY = (process.env.RELAY_KEY || "").trim();

const PIXELDRAIN_API_KEY = (process.env.PIXELDRAIN_API_KEY || "").trim();
// PixelDrain API base; point to a Cloudflare Worker relay
// (cloudflare-worker/pixeldrain-relay.js) if the host blocks pixeldrain.com
const PIXELDRAIN_API_BASE = (
  process.env.PIXELDRAIN_API_BASE || "https://pixeldrain.com"
).replace(/\/+$/, "");
const PIXELDRAIN_RELAY_KEY = (process.env.PIXELDRAIN_RELAY_KEY || "").trim();

const MOTION_THRESHOLD = 0.08; // 8% of decoded pixels changed
const MOTION_PIXEL_DELTA = 25; // per-pixel grayscale delta to count as changed
const ALERT_COOLDOWN_MS = 60 * 1000; // 60s between Telegram alerts

const FRAME_RATE = 10; // ESP32 sends ~10 FPS
const RECORD_CHUNK_FRAMES = parseInt(
  process.env.RECORD_CHUNK_FRAMES || "18000", // ~30 minutes @ 10fps
  10
);
const FRAMES_DIR = "/tmp/camera_frames";
const VIDEO_DIR = "/tmp/camera_video";

// Reuse connections and force IPv4 (containers often lack IPv6 egress,
// which makes Node hang on api.telegram.org while curl works)
const telegramAgent = new https.Agent({ keepAlive: true, family: 4 });

// ---- RAM-only state ----
let latestFrame = null; // latest JPEG buffer for the live stream
let prevPixels = null; // previous decoded 32x24 grayscale pixels
let motionBusy = false; // a frame is being decoded for motion
let lastAlertAt = 0; // timestamp of last Telegram alert
let aiBusy = false; // prevent overlapping AI pipelines
const streamClients = new Set(); // active MJPEG /stream responses
let recordCount = 0; // frames written in the current chunk
let recordBusy = false; // a frame is being annotated/written
let videoJobBusy = false; // an encode/upload job is running

const app = express();

// ---- Web UI dashboard ----
app.get("/", (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ESP32-CAM Giám Sát Vườn</title>
<style>
  body { margin:0; background:#0d1117; color:#e6edf3; font-family:Arial,sans-serif; text-align:center; }
  h1 { font-size:1.3rem; padding:12px 0 4px; }
  .status { font-size:.85rem; color:#8b949e; margin-bottom:10px; }
  .badge { padding:2px 10px; border-radius:10px; font-weight:bold; }
  .badge.ok { background:#1f6feb; color:#fff; }
  .badge.warn { background:#b62324; color:#fff; }
  canvas { max-width:100%; width:640px; border:2px solid #30363d; border-radius:8px; background:#161b22; }
</style>
</head>
<body>
<h1>📷 ESP32-CAM: Giám Sát Trực Tiếp</h1>
<div class="status">Live qua WebSocket · Lọc chuyển động · Cảnh báo YOLO qua Telegram · <span id="status" class="badge warn">ĐANG KẾT NỐI...</span></div>
<canvas id="view" width="640" height="480"></canvas>
<script>
  const statusEl = document.getElementById('status');
  const canvas = document.getElementById('view');
  const ctx = canvas.getContext('2d');

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const ws = new WebSocket(proto + location.host + '/view');
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => { statusEl.textContent = 'ĐANG HOẠT ĐỘNG'; statusEl.className = 'badge ok'; };
    ws.onclose = () => {
      statusEl.textContent = 'MẤT KẾT NỐI - ĐANG THỬ LẠI...';
      statusEl.className = 'badge warn';
      setTimeout(connect, 2000); // tự nối lại sau 2s
    };
    ws.onmessage = (event) => {
      const blob = new Blob([event.data], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); URL.revokeObjectURL(url); };
      img.src = url;
    };
  }
  connect();
</script>
</body>
</html>`);
});

// ---- Latest frame endpoint ----
app.get("/image.jpg", (req, res) => {
  if (!latestFrame) {
    return res.status(404).send("No frame yet");
  }
  res.set("Cache-Control", "no-store");
  res.type("jpeg").send(latestFrame);
});

// ---- MJPEG live stream (multipart/x-mixed-replace) ----
app.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    Pragma: "no-cache",
  });
  streamClients.add(res);
  if (latestFrame) pushMjpegFrame(res, latestFrame);
  req.on("close", () => streamClients.delete(res));
});

function pushMjpegFrame(res, frame) {
  res.write(
    `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`
  );
  res.write(frame);
  res.write("\r\n");
}

function broadcastFrame(frame) {
  for (const res of streamClients) {
    if (res.writableEnded || res.destroyed) {
      streamClients.delete(res);
      continue;
    }
    pushMjpegFrame(res, frame);
  }
  for (const client of wssViewer.clients) {
    if (client.readyState === client.OPEN && client.bufferedAmount < 1_000_000) {
      client.send(frame);
    }
  }
}

const server = http.createServer(app);

// ---- WebSockets: /esp32stream (camera, API key) and /view (browser viewers) ----
const wss = new WebSocketServer({ noServer: true });
const wssViewer = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/view") {
    wssViewer.handleUpgrade(req, socket, head, (ws) => {
      wssViewer.emit("connection", ws, req);
    });
    return;
  }
  if (url.pathname !== "/esp32stream") {
    socket.destroy();
    return;
  }
  const key = req.headers["x-api-key"];
  if (!API_KEY || key !== API_KEY) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wssViewer.on("connection", (ws) => {
  if (latestFrame) ws.send(latestFrame);
  ws.on("error", () => {});
});

wss.on("connection", (ws) => {
  console.log("[WS] ESP32-CAM connected");
  ws.on("message", (data, isBinary) => {
    if (!isBinary && !Buffer.isBuffer(data)) return;
    const frame = Buffer.isBuffer(data) ? data : Buffer.from(data);
    latestFrame = frame;
    broadcastFrame(frame);
    recordFrame(frame).catch((err) =>
      console.error("[REC] Frame error:", err.message)
    );
    detectMotion(frame)
      .then((moved) => {
        if (moved) {
          runAiPipeline(frame).catch((err) =>
            console.error("[AI] Pipeline error:", err.message)
          );
        }
      })
      .catch((err) => console.error("[Motion] Error:", err.message));
  });
  ws.on("close", () => console.log("[WS] ESP32-CAM disconnected"));
  ws.on("error", (err) => console.error("[WS] Error:", err.message));
});

// ---- Motion detection: decoded downscaled grayscale pixel diff ----
// Comparing compressed JPEG bytes is unreliable (entropy coding masks real
// movement and amplifies static-scene noise); compare actual pixels instead.
async function detectMotion(frame) {
  if (motionBusy) return false; // drop frame rather than queue decode work
  motionBusy = true;
  try {
    const { data } = await sharp(frame)
      .resize(32, 24) // tiny thumbnail: cheap to decode, reflects global change
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    if (!prevPixels || prevPixels.length !== data.length) {
      prevPixels = data;
      return false;
    }

    let diff = 0;
    for (let i = 0; i < data.length; i++) {
      if (Math.abs(data[i] - prevPixels[i]) > MOTION_PIXEL_DELTA) diff++;
    }
    prevPixels = data;
    return diff > data.length * MOTION_THRESHOLD;
  } catch (e) {
    console.log("[Motion] Lỗi decode ảnh:", e.message);
    return false;
  } finally {
    motionBusy = false;
  }
}

// ---- AI pipeline: enhance -> YOLO -> draw boxes -> Telegram ----
async function runAiPipeline(frame) {
  if (aiBusy) return;
  if (!GRADIO_SPACE) return;
  aiBusy = true;
  const t0 = Date.now();
  const step = (msg) => console.log(`[AI] +${Date.now() - t0}ms ${msg}`);
  try {
    step("pipeline start");
    // Night-time enhancement before sending to AI
    const enhanced = await sharp(frame)
      .modulate({ brightness: 1.2, saturation: 1.1 })
      .jpeg()
      .toBuffer();
    step(`enhance done (${enhanced.length} bytes)`);

    const result = await callYolo(enhanced);
    step(`yolo done (persons=${result.personCount}, boxes=${result.boxes.length})`);
    if (result.personCount <= 0 || result.boxes.length === 0) return;

    const now = Date.now();
    if (now - lastAlertAt < ALERT_COOLDOWN_MS) {
      step("cooldown active, skipping alert");
      return;
    }
    lastAlertAt = now;

    const annotated = await drawBoundingBoxes(enhanced, result.boxes);
    step(`draw done (${annotated.length} bytes)`);
    await sendTelegramAlert(annotated);
    step("telegram done");
  } finally {
    aiBusy = false;
  }
}

// @gradio/client is ESM-only; load via dynamic import and cache the connection
let gradioClientPromise = null;
function getGradioClient() {
  if (!gradioClientPromise) {
    gradioClientPromise = import("@gradio/client").then(({ Client }) =>
      Client.connect(GRADIO_SPACE)
    );
    gradioClientPromise.catch(() => {
      gradioClientPromise = null;
    });
  }
  return gradioClientPromise;
}

async function callYolo(imageBuffer) {
  try {
    const app = await getGradioClient();
    const imageBlob = new Blob([imageBuffer], { type: "image/jpeg" });
    const res = await app.predict("/detect_person", { image: imageBlob });

    // Gradio response: { data: [ { person_count, boxes: [{x1,y1,x2,y2,confidence}] } ] }
    const payload = res.data && Array.isArray(res.data) ? res.data[0] : null;
    if (!payload) return { personCount: 0, boxes: [] };
    const boxes = Array.isArray(payload.boxes) ? payload.boxes : [];
    const personCount = Number(payload.person_count) || boxes.length;
    return { personCount, boxes };
  } catch (err) {
    console.error("[AI Call Error]", err.message);
    return { personCount: 0, boxes: [] };
  }
}

async function drawBoundingBoxes(imageBuffer, boxes) {
  const meta = await sharp(imageBuffer).metadata();
  const imgW = meta.width || 640;
  const imgH = meta.height || 480;

  const rects = boxes
    .map((b) => {
      const x = Number(b.x1) || 0;
      const y = Number(b.y1) || 0;
      const w = (Number(b.x2) || 0) - x;
      const h = (Number(b.y2) || 0) - y;
      if (w <= 0 || h <= 0) return "";
      const score = Math.round((Number(b.confidence) || 0) * 100);
      const labelY = y > 22 ? y - 8 : y + h + 18;
      return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}"
      fill="none" stroke="red" stroke-width="3"/>
    <text x="${x + 2}" y="${labelY}" font-size="18" font-family="Arial"
      fill="red" stroke="black" stroke-width="0.5" font-weight="bold">person ${score}%</text>`;
    })
    .join("");

  const svg = Buffer.from(
    `<svg width="${imgW}" height="${imgH}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`
  );

  return sharp(imageBuffer)
    .composite([{ input: svg, top: 0, left: 0 }])
    .jpeg()
    .toBuffer();
}

// ---- Video recording -> ffmpeg -> PixelDrain -> Telegram ----
function vnTimestamp() {
  return new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}

// Full date+time overlay (bottom-left) burned into frames and alert photos
async function annotateTimestamp(imageBuffer) {
  const meta = await sharp(imageBuffer).metadata();
  const imgW = meta.width || 640;
  const imgH = meta.height || 480;
  const svg = Buffer.from(
    `<svg width="${imgW}" height="${imgH}" xmlns="http://www.w3.org/2000/svg">
  <rect x="4" y="${imgH - 26}" width="250" height="22" fill="black" fill-opacity="0.55" rx="3"/>
  <text x="10" y="${imgH - 10}" font-size="14" font-family="Arial" fill="white">${vnTimestamp()}</text>
</svg>`
  );
  return sharp(imageBuffer)
    .composite([{ input: svg, top: 0, left: 0 }])
    .jpeg()
    .toBuffer();
}

async function recordFrame(frame) {
  if (!PIXELDRAIN_API_KEY) return; // recording disabled without upload target
  if (recordBusy) return; // drop frame rather than queue up CPU work
  recordBusy = true;
  try {
    fs.mkdirSync(FRAMES_DIR, { recursive: true });
    const stamped = await annotateTimestamp(frame);
    const name = `frame_${String(recordCount).padStart(8, "0")}.jpg`;
    await fs.promises.writeFile(path.join(FRAMES_DIR, name), stamped);
    recordCount++;
    if (recordCount >= RECORD_CHUNK_FRAMES) {
      const frames = recordCount;
      recordCount = 0;
      finalizeVideoChunk(frames).catch((err) =>
        console.error("[REC] Video job error:", err.message)
      );
    }
  } finally {
    recordBusy = false;
  }
}

async function finalizeVideoChunk(frameTotal) {
  if (videoJobBusy) return;
  videoJobBusy = true;
  const jobDir = `/tmp/camera_frames_job_${Date.now()}`;
  const outPath = path.join(VIDEO_DIR, `camera_${Date.now()}.mp4`);
  try {
    fs.renameSync(FRAMES_DIR, jobDir); // recording continues into a fresh dir
    fs.mkdirSync(VIDEO_DIR, { recursive: true });
    console.log(`[REC] Encoding ${frameTotal} frames...`);
    await runFfmpeg(path.join(jobDir, "frame_%08d.jpg"), outPath);
    const link = await uploadToPixelDrain(outPath);
    console.log(`[REC] Uploaded: ${link}`);
    await sendTelegramMessage(
      `📹 Video giám sát 30 phút (${vnTimestamp()}): ${link}`
    );
  } finally {
    // Always clean /tmp, even on mid-job failure
    fs.rmSync(jobDir, { recursive: true, force: true });
    fs.rmSync(outPath, { force: true });
    videoJobBusy = false;
  }
}

function runFfmpeg(inputPattern, outputPath) {
  return new Promise((resolve, reject) => {
    console.time("[FFmpeg] Nén video");
    const args = [
      "-c", "1", // pin to core 1 - core 0 stays free for Node/AI/motion/stream
      "cpulimit", "-l", "80", "--",
      "ffmpeg", "-y",
      "-threads", "1",
      "-framerate", String(FRAME_RATE),
      "-i", inputPattern,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-pix_fmt", "yuv420p",
      outputPath,
    ];
    const proc = spawn("taskset", args);
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      console.timeEnd("[FFmpeg] Nén video");
      if (code === 0) resolve();
      else reject(new Error(`FFMPEG lỗi ${code}: ${stderr.slice(-400)}`));
    });
    proc.on("error", reject);
  });
}

async function uploadToPixelDrain(filePath) {
  const name = path.basename(filePath);
  const res = await axios.put(
    `${PIXELDRAIN_API_BASE}/api/file/${encodeURIComponent(name)}`,
    fs.createReadStream(filePath),
    {
      auth: { username: "", password: PIXELDRAIN_API_KEY },
      headers: {
        "Content-Type": "application/octet-stream",
        ...(PIXELDRAIN_RELAY_KEY ? { "X-Relay-Key": PIXELDRAIN_RELAY_KEY } : {}),
      },
      httpsAgent: telegramAgent,
      timeout: 10 * 60 * 1000,
      maxBodyLength: Infinity,
    }
  );
  return `https://pixeldrain.com/u/${res.data.id}`;
}

async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !CHAT_ID) return;
  await axios.post(
    `${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    { chat_id: CHAT_ID, text },
    {
      headers: RELAY_KEY ? { "X-Relay-Key": RELAY_KEY } : {},
      httpsAgent: telegramAgent,
      timeout: 30000,
    }
  );
}

async function sendTelegramAlert(imageBuffer) {
  if (!TELEGRAM_BOT_TOKEN || !CHAT_ID) {
    console.warn("[TG] Missing TELEGRAM_BOT_TOKEN or CHAT_ID, skipping alert");
    return;
  }
  const time = vnTimestamp();
  const caption = `🚨 CẢNH BÁO KHẨN CẤP: Phát hiện trộm trong vườn sầu riêng lúc ${time}!`;
  imageBuffer = await annotateTimestamp(imageBuffer);
  const url = `${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`;

  const attempt = async () => {
    const form = new FormData();
    form.append("chat_id", CHAT_ID);
    form.append("caption", caption);
    form.append("photo", imageBuffer, {
      filename: "alert.jpg",
      contentType: "image/jpeg",
    });
    return axios.post(url, form, {
      headers: {
        ...form.getHeaders(),
        ...(RELAY_KEY ? { "X-Relay-Key": RELAY_KEY } : {}),
      },
      httpsAgent: telegramAgent,
      timeout: 30000,
      maxBodyLength: Infinity,
    });
  };

  try {
    await attempt();
  } catch (err) {
    console.warn(`[TG] sendPhoto failed (${err.message}), retrying once...`);
    await attempt();
  }
  console.log("[TG] Alert sent");
}

server.listen(PORT, () => {
  console.log(`ESP32-CAM server listening on port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/`);
  console.log(`WebSocket: ws://localhost:${PORT}/esp32stream (header x-api-key)`);
});
