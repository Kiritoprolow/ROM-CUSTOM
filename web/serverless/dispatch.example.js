/**
 * MẪU SERVERLESS PROXY (Vercel Function) — GIỮ GITHUB TOKEN AN TOÀN
 * ================================================================
 * Đặt file này tại `api/dispatch.js` trong một project Vercel riêng (hoặc
 * chuyển thành Cloudflare/Netlify Function tương ứng), rồi cấu hình biến
 * môi trường GITHUB_TOKEN (fine-grained: Contents:Read + Actions:Write,
 * chỉ trên repo này). Token nằm phía server, KHÔNG lộ ra client.
 *
 * Frontend (config.js) đặt DISPATCH_MODE = "proxy" và PROXY_ENDPOINT trỏ
 * tới URL của function này.
 *
 * Deploy: `vercel deploy`. Nhớ bật CORS cho domain web tĩnh của bạn.
 */

const GITHUB_REPO = "Kiritoprolow/ROM-CUSTOM";
const DISPATCH_EVENT_TYPE = "create_video";

// Chỉ cho phép domain frontend của bạn gọi (đổi cho đúng)
const ALLOWED_ORIGIN = "https://your-frontend-domain.example";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { links, job_id } = req.body || {};
  if (!Array.isArray(links) || links.length === 0 || !job_id) {
    return res.status(400).json({ error: "Thiếu links hoặc job_id" });
  }

  // Chặn lạm dụng cơ bản: chỉ nhận link Shopee hợp lệ
  const valid = links.every((u) => /^https?:\/\/([\w.-]*shopee\.|[\w.-]*shp\.ee)/i.test(u));
  if (!valid) return res.status(400).json({ error: "Link không hợp lệ" });

  const ghRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: DISPATCH_EVENT_TYPE,
      client_payload: { links, job_id },
    }),
  });

  if (!ghRes.ok) {
    const text = await ghRes.text();
    return res.status(502).json({ error: "GitHub dispatch failed", detail: text });
  }
  return res.status(202).json({ ok: true, job_id });
}
