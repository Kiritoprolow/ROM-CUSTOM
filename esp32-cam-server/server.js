"use strict";

const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const axios = require("axios");
const FormData = require("form-data");
const sharp = require("sharp");

const PORT = parseInt(process.env.PORT || "7860", 10);
const API_KEY = process.env.API_KEY || "";
const YOLO_API_URL = process.env.YOLO_API_URL || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.CHAT_ID || "";

const MOTION_THRESHOLD = 0.15; // 15% pixel variance
const MOTION_SAMPLE_STEP = 50; // sparse byte sampling step
const ALERT_COOLDOWN_MS = 60 * 1000; // 60s between Telegram alerts

// ---- RAM-only state ----
let latestFrame = null; // latest JPEG buffer for the live stream
let prevFrame = null; // previous frame for motion comparison
let lastAlertAt = 0; // timestamp of last Telegram alert
let aiBusy = false; // prevent overlapping AI pipelines

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
<div class="status">Stream ~10 FPS · Lọc chuyển động · Cảnh báo YOLO qua Telegram</div>
<img id="stream" src="/image.jpg" alt="Đang chờ tín hiệu từ ESP32-CAM...">
<script>
  const img = document.getElementById("stream");
  setInterval(() => {
    img.src = "/image.jpg?t=" + Date.now();
  }, 100);
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
  if (!YOLO_API_URL) return;
  aiBusy = true;
  try {
    // Night-time enhancement before sending to AI
    const enhanced = await sharp(frame)
      .modulate({ brightness: 1.2, saturation: 1.1 })
      .jpeg()
      .toBuffer();

    const detections = await callYolo(enhanced);
    const persons = detections.filter(
      (d) => String(d.class).toLowerCase() === "person"
    );
    if (persons.length === 0) return;

    const now = Date.now();
    if (now - lastAlertAt < ALERT_COOLDOWN_MS) return;
    lastAlertAt = now;

    const annotated = await drawBoundingBoxes(enhanced, persons);
    await sendTelegramAlert(annotated);
  } finally {
    aiBusy = false;
  }
}

async function callYolo(imageBuffer) {
  const form = new FormData();
  form.append("file", imageBuffer, {
    filename: "frame.jpg",
    contentType: "image/jpeg",
  });
  const res = await axios.post(YOLO_API_URL, form, {
    headers: form.getHeaders(),
    timeout: 15000,
    maxBodyLength: Infinity,
  });
  const data = res.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.detections)) return data.detections;
  if (Array.isArray(data.predictions)) return data.predictions;
  return [];
}

// Normalize a box to pixel {x, y, w, h}.
// Supports [ymin, xmin, ymax, xmax] and [x, y, width, height],
// with either pixel or normalized (0..1) coordinates.
function normalizeBox(box, imgW, imgH) {
  let [a, b, c, d] = box.map(Number);
  const isNormalized = Math.max(a, b, c, d) <= 1.5;
  if (isNormalized) {
    a *= imgH;
    b *= imgW;
    c *= imgH;
    d *= imgW;
  }
  // Heuristic: [ymin, xmin, ymax, xmax] when c > a and d > b look like maxes
  if (c > a && d > b && c <= imgH * 1.05 && d <= imgW * 1.05) {
    const ymin = a, xmin = b, ymax = c, xmax = d;
    return { x: xmin, y: ymin, w: xmax - xmin, h: ymax - ymin };
  }
  // Otherwise treat as [x, y, width, height]
  return { x: a, y: b, w: c, h: d };
}

async function drawBoundingBoxes(imageBuffer, persons) {
  const meta = await sharp(imageBuffer).metadata();
  const imgW = meta.width || 640;
  const imgH = meta.height || 480;

  const rects = persons
    .map((p) => {
      const { x, y, w, h } = normalizeBox(p.box || p.bbox || [0, 0, 0, 0], imgW, imgH);
      if (w <= 0 || h <= 0) return "";
      const score = Math.round((Number(p.score) || 0) * 100);
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
  const form = new FormData();
  form.append("chat_id", CHAT_ID);
  form.append(
    "caption",
    `🚨 CẢNH BÁO KHẨN CẤP: Phát hiện trộm trong vườn sầu riêng lúc ${time}!`
  );
  form.append("photo", imageBuffer, {
    filename: "alert.jpg",
    contentType: "image/jpeg",
  });
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
    form,
    { headers: form.getHeaders(), timeout: 15000, maxBodyLength: Infinity }
  );
  console.log("[TG] Alert sent");
}

server.listen(PORT, () => {
  console.log(`ESP32-CAM server listening on port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/`);
  console.log(`WebSocket: ws://localhost:${PORT}/esp32stream (header x-api-key)`);
});
