/**
 * LOGIC FRONTEND — Shopee → TikTok Video Generator
 * ================================================
 * - Kiểm tra đầu vào (gói Free: đúng 1 link).
 * - Kích hoạt Premium bằng cách so khớp SHA-256 (không lưu key plaintext).
 * - Cooldown 24h qua localStorage cho gói Free.
 * - Gửi repository_dispatch (qua serverless proxy hoặc trực tiếp) kèm link.
 * - Polling Cloudinary tới khi có video rồi hiện nút tải.
 */

(function () {
  "use strict";

  const CFG = window.APP_CONFIG || {};
  const LS_PREMIUM = "stg_premium"; // trạng thái premium
  const LS_COOLDOWN = "stg_cooldown_until"; // mốc thời gian hết cooldown (ms)

  // ---- DOM ----
  const el = (id) => document.getElementById(id);
  const linkInput = el("linkInput");
  const generateBtn = el("generateBtn");
  const errorMsg = el("errorMsg");
  const keyInput = el("keyInput");
  const activateKeyBtn = el("activateKeyBtn");
  const keyMsg = el("keyMsg");
  const loadingArea = el("loadingArea");
  const loadingStep = el("loadingStep");
  const resultArea = el("resultArea");
  const resultVideo = el("resultVideo");
  const downloadBtn = el("downloadBtn");
  const planName = el("planName");
  const buyPremiumBtn = el("buyPremiumBtn");
  const premiumModal = el("premiumModal");
  const closeModalBtn = el("closeModalBtn");
  const adSlots = document.querySelectorAll("[data-ad-slot]");

  let cooldownTimer = null;

  // =========================================================
  // TIỆN ÍCH
  // =========================================================
  function isPremium() {
    return localStorage.getItem(LS_PREMIUM) === "1";
  }

  async function sha256Hex(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.classList.remove("hidden");
  }
  function clearError() {
    errorMsg.textContent = "";
    errorMsg.classList.add("hidden");
  }

  // Tách danh sách link từ ô nhập (theo dòng hoặc dấu phẩy)
  function parseLinks(raw) {
    return raw
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function looksLikeShopee(url) {
    return /^https?:\/\/([\w.-]*shopee\.|[\w.-]*shp\.ee)/i.test(url);
  }

  // =========================================================
  // GIAO DIỆN THEO GÓI (FREE / PREMIUM)
  // =========================================================
  function applyPlanUI() {
    const premium = isPremium();
    planName.textContent = premium ? "PREMIUM 👑" : "FREE";
    planName.className = premium ? "text-neon-lime" : "text-neon-cyan";

    // Premium: ẩn toàn bộ quảng cáo và CTA
    adSlots.forEach((slot) => {
      slot.closest("[data-ad-slot]").style.display = premium ? "none" : "";
      // ẩn cả container cha (aside / wrapper) cho gọn
      const wrapper = slot.parentElement;
      if (premium && wrapper) wrapper.style.display = "none";
      else if (wrapper) wrapper.style.display = "";
    });
    document.querySelectorAll("aside").forEach((a) => {
      a.style.display = premium ? "none" : "";
    });
    el("premiumCta").style.display = premium ? "none" : "";

    // Placeholder ô nhập
    linkInput.placeholder = premium
      ? "Dán nhiều link Shopee (mỗi dòng 1 link) — Premium không giới hạn"
      : "https://shopee.vn/... (Gói Free: dán đúng 1 link)";

    refreshCooldownUI();
  }

  // =========================================================
  // COOLDOWN (chỉ áp dụng gói Free)
  // =========================================================
  function refreshCooldownUI() {
    if (cooldownTimer) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
    }
    if (isPremium()) {
      enableGenerate();
      return;
    }
    const until = parseInt(localStorage.getItem(LS_COOLDOWN) || "0", 10);
    if (Date.now() < until) {
      startCooldownCountdown(until);
    } else {
      enableGenerate();
    }
  }

  function enableGenerate() {
    generateBtn.disabled = false;
    generateBtn.textContent = "BẮT ĐẦU TẠO VIDEO 🎬";
  }

  function startCooldownCountdown(until) {
    generateBtn.disabled = true;
    const tick = () => {
      const remain = until - Date.now();
      if (remain <= 0) {
        clearInterval(cooldownTimer);
        cooldownTimer = null;
        clearError();
        enableGenerate();
        return;
      }
      const h = Math.floor(remain / 3.6e6);
      const m = Math.floor((remain % 3.6e6) / 6e4);
      const s = Math.floor((remain % 6e4) / 1000);
      generateBtn.textContent = `⏳ Chờ ${h}h ${m}m ${s}s (mua Premium để bỏ qua)`;
    };
    tick();
    cooldownTimer = setInterval(tick, 1000);
  }

  function setCooldown() {
    const until = Date.now() + (CFG.FREE_COOLDOWN_HOURS || 24) * 3.6e6;
    localStorage.setItem(LS_COOLDOWN, String(until));
    refreshCooldownUI();
  }

  // =========================================================
  // KÍCH HOẠT PREMIUM KEY (so khớp SHA-256)
  // =========================================================
  async function activateKey() {
    const key = keyInput.value.trim();
    keyMsg.classList.add("hidden");
    if (!key) return;

    const hash = await sha256Hex(key);
    const valid = (CFG.PREMIUM_KEY_HASHES || []).includes(hash);

    keyMsg.classList.remove("hidden");
    if (valid) {
      localStorage.setItem(LS_PREMIUM, "1");
      keyMsg.textContent = "✅ Kích hoạt Premium thành công! Đã mở khóa toàn bộ tính năng.";
      keyMsg.className = "mt-2 text-xs font-medium text-neon-lime";
      keyInput.value = "";
      applyPlanUI();
    } else {
      keyMsg.textContent = "❌ Key không hợp lệ. Vui lòng kiểm tra lại.";
      keyMsg.className = "mt-2 text-xs font-medium text-red-400";
    }
  }

  // =========================================================
  // GỬI YÊU CẦU TẠO VIDEO
  // =========================================================
  function validateInput() {
    clearError();
    const links = parseLinks(linkInput.value);

    if (links.length === 0) {
      showError("Vui lòng dán link sản phẩm Shopee!");
      return null;
    }
    // Gói Free: chỉ chấp nhận đúng 1 link
    if (!isPremium() && links.length > 1) {
      showError("Gói Free chỉ cho phép 1 link duy nhất. Nâng cấp Premium để nhập hàng loạt!");
      return null;
    }
    for (const url of links) {
      if (!looksLikeShopee(url)) {
        showError(`Link không hợp lệ: ${url}`);
        return null;
      }
    }
    return links;
  }

  // Tạo jobId ngẫu nhiên để backend đặt tên file và frontend polling
  function makeJobId() {
    return "job_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  async function dispatchWorkflow(links, jobId) {
    const payload = { links, job_id: jobId };

    if (CFG.DISPATCH_MODE === "proxy") {
      const res = await fetch(CFG.PROXY_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`Proxy trả về ${res.status}`);
      return;
    }

    // Chế độ direct: gọi thẳng GitHub API (token lộ ở client — kém an toàn)
    const res = await fetch(`https://api.github.com/repos/${CFG.GITHUB_REPO}/dispatches`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${CFG.GITHUB_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ event_type: CFG.DISPATCH_EVENT_TYPE, client_payload: payload }),
    });
    if (!res.ok) throw new Error(`GitHub API trả về ${res.status}`);
  }

  // URL video kỳ vọng trên Cloudinary
  function cloudinaryVideoUrl(jobId) {
    return `https://res.cloudinary.com/${CFG.CLOUDINARY_CLOUD_NAME}/video/upload/${CFG.CLOUDINARY_FOLDER}/${jobId}.mp4`;
  }

  // Polling: kiểm tra video đã tồn tại trên Cloudinary chưa
  async function pollForVideo(jobId) {
    const url = cloudinaryVideoUrl(jobId);
    const maxAttempts = CFG.POLL_MAX_ATTEMPTS || 120;
    const interval = CFG.POLL_INTERVAL_MS || 5000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      loadingStep.textContent = `Đang render & chờ video... (lần kiểm tra ${attempt}/${maxAttempts})`;
      try {
        const res = await fetch(url, { method: "HEAD", cache: "no-store" });
        if (res.ok) return url;
      } catch (_) {
        /* bỏ qua lỗi mạng tạm thời, thử lại */
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error("Hết thời gian chờ — video chưa sẵn sàng. Vui lòng thử lại sau.");
  }

  async function handleGenerate() {
    const links = validateInput();
    if (!links) return;

    generateBtn.disabled = true;
    loadingArea.classList.remove("hidden");
    resultArea.classList.add("hidden");
    loadingStep.textContent = "Đang gửi yêu cầu tới máy chủ xử lý...";

    const jobId = makeJobId();

    try {
      await dispatchWorkflow(links, jobId);
      const videoUrl = await pollForVideo(jobId);

      // Hiện kết quả
      resultVideo.src = videoUrl;
      downloadBtn.href = videoUrl;
      loadingArea.classList.add("hidden");
      resultArea.classList.remove("hidden");
      resultArea.scrollIntoView({ behavior: "smooth" });

      // Gói Free: bật cooldown sau khi tạo thành công
      if (!isPremium()) setCooldown();
      else enableGenerate();
    } catch (err) {
      loadingArea.classList.add("hidden");
      showError("❌ " + err.message);
      refreshCooldownUI();
    }
  }

  // =========================================================
  // KHỞI TẠO
  // =========================================================
  function init() {
    applyPlanUI();

    generateBtn.addEventListener("click", handleGenerate);
    activateKeyBtn.addEventListener("click", activateKey);
    keyInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") activateKey();
    });

    buyPremiumBtn.addEventListener("click", () => premiumModal.classList.remove("hidden"));
    closeModalBtn.addEventListener("click", () => premiumModal.classList.add("hidden"));
    premiumModal.addEventListener("click", (e) => {
      if (e.target === premiumModal) premiumModal.classList.add("hidden");
    });

    // Tự co giãn textarea
    linkInput.addEventListener("input", () => {
      linkInput.style.height = "auto";
      linkInput.style.height = Math.min(linkInput.scrollHeight, 160) + "px";
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
