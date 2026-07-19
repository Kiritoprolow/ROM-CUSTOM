/**
 * CẤU HÌNH FRONTEND
 * =================
 * Chỉnh các giá trị dưới đây cho đúng dự án của bạn trước khi deploy.
 *
 * ⚠️ LƯU Ý BẢO MẬT QUAN TRỌNG:
 * Web tĩnh KHÔNG có server, nên nếu đặt GitHub token trực tiếp ở đây thì
 * bất kỳ ai cũng xem được qua tab Network/Sources của trình duyệt.
 *
 * Có 2 hướng triển khai:
 *
 *  (A) KHUYẾN NGHỊ — dùng serverless proxy (an toàn thật sự):
 *      Đặt DISPATCH_MODE = "proxy" và trỏ PROXY_ENDPOINT tới một hàm
 *      serverless (Vercel / Cloudflare Functions / Netlify) mà bạn tự viết.
 *      Hàm đó giữ GITHUB_TOKEN trong biến môi trường phía server và gọi
 *      repository_dispatch giúp. Token KHÔNG bao giờ lộ ra client.
 *      (Xem web/serverless/dispatch.example.js để có mẫu.)
 *
 *  (B) NHANH GỌN — gọi thẳng GitHub API từ client (KÉM AN TOÀN):
 *      Đặt DISPATCH_MODE = "direct" và điền GITHUB_TOKEN (fine-grained,
 *      chỉ quyền Contents:Read + Actions:Write, chỉ trên repo này).
 *      Token vẫn lộ với người dùng — chỉ dùng khi bạn chấp nhận rủi ro
 *      và token đã bị giới hạn quyền tối đa. Nên bật Rate Limiting qua
 *      Cloudflare để hạn chế lạm dụng.
 */
window.APP_CONFIG = {
  // "proxy" (khuyến nghị) hoặc "direct"
  DISPATCH_MODE: "proxy",

  // Repo chứa workflow (owner/repo)
  GITHUB_REPO: "Kiritoprolow/ROM-CUSTOM",

  // Tên event của repository_dispatch (phải khớp với workflow)
  DISPATCH_EVENT_TYPE: "create_video",

  // (Chỉ dùng khi DISPATCH_MODE = "proxy") endpoint serverless của bạn
  PROXY_ENDPOINT: "https://your-app.vercel.app/api/dispatch",

  // (Chỉ dùng khi DISPATCH_MODE = "direct") — LỘ với người dùng, cân nhắc kỹ!
  GITHUB_TOKEN: "",

  // Cloudinary: dùng để polling video sau khi render xong.
  // Backend (GitHub Actions) upload video lên Cloudinary với public_id =
  // `${CLOUDINARY_FOLDER}/${jobId}`; frontend polling đúng URL đó.
  CLOUDINARY_CLOUD_NAME: "your_cloud_name",
  CLOUDINARY_FOLDER: "shopee_tiktok",

  // Cấu hình gói Free
  FREE_COOLDOWN_HOURS: 24,

  // Hash SHA-256 của (các) Premium Key hợp lệ.
  // KHÔNG lưu key dạng text. Tạo hash bằng lệnh:
  //   echo -n "PREMIUM-KEY-CUA-BAN" | shasum -a 256
  // rồi dán chuỗi hash (64 ký tự hex) vào mảng dưới đây.
  // Mặc định dưới đây là hash của "PREMIUM-DEMO-2024" (chỉ để demo — hãy đổi!).
  PREMIUM_KEY_HASHES: [
    // hash của "PREMIUM-DEMO-2024" — ĐỔI thành hash key thật của bạn!
    "10bdb66b07c648c1b410e48dcf592186196fe5a19010dc9143d8b4befbda53b2",
  ],

  // Thời gian polling (ms) và số lần tối đa
  POLL_INTERVAL_MS: 5000,
  POLL_MAX_ATTEMPTS: 120, // 120 * 5s = 10 phút
};
