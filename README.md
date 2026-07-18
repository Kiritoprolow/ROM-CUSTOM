# Shopee To TikTok Video Generator

Tool tự động hóa bằng Python: nhập link sản phẩm Shopee → cào dữ liệu → AI (Gemini) viết kịch bản → chuyển thành giọng đọc AI → dựng video TikTok dọc 9:16 hoàn chỉnh để làm Affiliate.

## Kiến trúc 4 Module

| Module | File | Công nghệ | Chức năng |
|---|---|---|---|
| 1. Shopee Scraper | `shopee_scraper.py` | Playwright | Cào tên, giá, mô tả và tải 5-7 ảnh sản phẩm về thư mục `/images` |
| 2. AI Script Generator | `script_generator.py` | Google Gemini (`gemini-flash-latest`) | Viết kịch bản TikTok < 60s dạng JSON (`hook`, `problem`, `features`, `cta`) |
| 3. Text-To-Speech | `tts_generator.py` | edge-tts (Microsoft, miễn phí) | Chuyển lời thoại thành `audio.mp3` giọng tiếng Việt |
| 4. Video Compositor | `video_compositor.py` | MoviePy | Ghép ảnh thành video slide có hiệu ứng zoom, khớp độ dài audio, xuất `final_video.mp4` (9:16) |

## Cài đặt

```bash
# 1. Cài các thư viện Python
pip install -r requirements.txt

# 2. Cài trình duyệt Chromium cho Playwright
playwright install chromium

# 3. Thiết lập API key Gemini (miễn phí tại https://aistudio.google.com/app/apikey)
export GEMINI_API_KEY='your_api_key'
```

> Lưu ý: MoviePy cần `ffmpeg`. Nếu máy chưa có: `sudo apt install ffmpeg` (Linux) hoặc tải tại https://ffmpeg.org.

## Sử dụng

### Giao diện Web (khuyến nghị)

```bash
streamlit run app.py
```

Mở trình duyệt tại địa chỉ hiển thị (mặc định http://localhost:8501), dán link Shopee và bấm **BẮT ĐẦU TẠO VIDEO 🎬**. Kịch bản, trình phát video và nút tải video sẽ hiện ngay trên trang.

### Dòng lệnh

```bash
# Cách 1: truyền link trực tiếp
python main.py "https://shopee.vn/ten-san-pham-i.12345678.87654321"

# Cách 2: chạy rồi nhập link khi được hỏi
python main.py
```

Kết quả đầu ra:
- `images/` — ảnh sản phẩm đã tải về
- `script.json` — kịch bản (lời thoại + mô tả phân cảnh)
- `audio.mp3` — giọng đọc AI tiếng Việt
- `final_video.mp4` — video TikTok thành phẩm (1080x1920)

## Tùy chỉnh

- **Đổi giọng đọc**: sửa `DEFAULT_VOICE` trong `tts_generator.py` (`vi-VN-HoaiMyNeural` giọng nữ, `vi-VN-NamMinhNeural` giọng nam).
- **Thời gian mỗi ảnh**: sửa `MIN_IMAGE_DURATION` / `MAX_IMAGE_DURATION` trong `video_compositor.py`.
- **Số ảnh tải về**: sửa `MAX_IMAGES` trong `shopee_scraper.py`.

## Chạy tự động bằng GitHub Actions + Telegram

Ngoài Web/CLI, repo có sẵn bot tự động (`run_bot.py` + `.github/workflows/auto_render.yml`):

1. Vào **Settings → Secrets and variables → Actions** của repo, thêm các Secret:
   - `GEMINI_API_KEY` — API key Gemini (bắt buộc).
   - `TELEGRAM_BOT_TOKEN` — token bot Telegram, tạo qua [@BotFather](https://t.me/BotFather) (bắt buộc).
   - `TELEGRAM_CHAT_ID` — chat ID nhận video, lấy qua [@userinfobot](https://t.me/userinfobot) (bắt buộc). Nhớ bấm **Start** với bot của bạn trước.
   - `PROXY_URL` — proxy dân dụng dạng `http://user:pass@host:port` để né Shopee chặn IP datacenter của GitHub (khuyến nghị mạnh).
2. Thêm link sản phẩm Shopee vào `links.txt` (mỗi dòng 1 link) rồi push lên GitHub.
3. Workflow tự chạy: cào dữ liệu → Gemini viết kịch bản → tạo giọng đọc → render video → gửi `final_video.mp4` về Telegram. Video cũng được lưu làm artifact trong tab Actions để tải dự phòng.

## Lưu ý về Shopee

Shopee có cơ chế chống bot khá mạnh. Tool dùng Playwright (trình duyệt thật) + User-Agent chuẩn để giảm khả năng bị chặn, nhưng nếu bị yêu cầu đăng nhập/captcha, hãy thử lại sau hoặc dùng link sản phẩm khác.
