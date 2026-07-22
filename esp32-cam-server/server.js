"use strict";

const http = require("http");
const https = require("https");
const express = require("express");
const { WebSocketServer } = require("ws");
const axios = require("axios");
const FormData = require("form-data");
const sharp = require("sharp");

// TEST MẠNG - XOÁ SAU KHI DEBUG XONG
axios.get('https://api.telegram.org', { timeout: 10000 })
  .then(r => console.log('[NETWORK TEST] Telegram OK, status:', r.status))
  .catch(e => console.log('[NETWORK TEST] Telegram FAILED:', e.code || e.message));

axios.get('https://huggingface.co', { timeout: 10000 })
  .then(r => console.log('[NETWORK TEST] HuggingFace OK, status:', r.status))
  .catch(e => console.log('[NETWORK TEST] HuggingFace FAILED:', e.code || e.message));

const PORT = parseInt(process.env.PORT || "7860", 10);
const API_KEY = process.env.API_KEY || "";
const GRADIO_SPACE =
  process.env.GRADIO_SPACE || "Kakaytbrr/vuon-sau-rieng-face-detect";
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const CHAT_ID = (process.env.CHAT_ID || "").trim();

const MOTION_THRESHOLD = 0.15; // 15% pixel variance
const MOTION_SAMPLE_STEP = 50; // sparse byte sampling step
const ALERT_COOLDOWN_MS = 60 * 1000; // 60s between Telegram alerts

// Reuse connections and force IPv4 (containers often lack IPv6 egress,
// which makes Node hang on api.telegram.org while curl works)
const telegramAgent = new https.Agent({ keepAlive: true, family: 4 });

// ---- RAM-only state ----
let latestFrame = null; // latest JPEG buffer for the live stream
let prevFrame = null; // previous frame for motion comparison
let lastAlertAt = 0; // timestamp of last Telegram alert
let aiBusy = false; // prevent overlapping AI pipelines
const streamClients = new Set(); // active MJPEG /stream responses

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
  img { max-width:100%; width:640px; border:2px solid #30363d; border-radius:8px; background:#161b22; }
</style>
</head>
<body>
<h1>📷 ESP32-CAM: Giám Sát Trực Tiếp</h1>
<div class="status">MJPEG stream trực tiếp · Lọc chuyển động · Cảnh báo YOLO qua Telegram</div>
<img src="/stream" alt="Đang chờ tín hiệu từ ESP32-CAM...">
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
}

const server = http.createServer(app);

// ---- WebSocket: receive JPEG frames from ESP32-CAM ----
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
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

wss.on("connection", (ws) => {
  console.log("[WS] ESP32-CAM connected");
  ws.on("message", (data, isBinary) => {
    if (!isBinary && !Buffer.isBuffer(data)) return;
    const frame = Buffer.isBuffer(data) ? data : Buffer.from(data);
    latestFrame = frame;
    broadcastFrame(frame);
    if (detectMotion(frame)) {
      runAiPipeline(frame).catch((err) =>
        console.error("[AI] Pipeline error:", err.message)
      );
    }
  });
  ws.on("close", () => console.log("[WS] ESP32-CAM disconnected"));
  ws.on("error", (err) => console.error("[WS] Error:", err.message));
});

// ---- Motion detection: sparse byte sampling ----
function detectMotion(frame) {
  const prev = prevFrame;
  prevFrame = frame;
  if (!prev) return false;

  const len = Math.min(prev.length, frame.length);
  let samples = 0;
  let changed = 0;
  for (let i = 0; i < len; i += MOTION_SAMPLE_STEP) {
    samples++;
    if (Math.abs(prev[i] - frame[i]) > 25) changed++;
  }
  if (samples === 0) return false;
  return changed / samples > MOTION_THRESHOLD;
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

async function sendTelegramAlert(imageBuffer) {
  if (!TELEGRAM_BOT_TOKEN || !CHAT_ID) {
    console.warn("[TG] Missing TELEGRAM_BOT_TOKEN or CHAT_ID, skipping alert");
    return;
  }
  const time = new Date().toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
  });
  const caption = `🚨 CẢNH BÁO KHẨN CẤP: Phát hiện trộm trong vườn sầu riêng lúc ${time}!`;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`;

  const attempt = async () => {
    const form = new FormData();
    form.append("chat_id", CHAT_ID);
    form.append("caption", caption);
    form.append("photo", imageBuffer, {
      filename: "alert.jpg",
      contentType: "image/jpeg",
    });
    return axios.post(url, form, {
      headers: form.getHeaders(),
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
