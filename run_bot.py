"""
RUN BOT - PIPELINE TỰ ĐỘNG CHO GITHUB ACTIONS
=============================================
Đọc danh sách link Shopee từ links.txt -> cào dữ liệu -> Gemini viết kịch bản
-> edge-tts tạo giọng đọc -> MoviePy render video 9:16 -> gửi video về Telegram.

Biến môi trường cần thiết (truyền qua GitHub Secrets):
- GEMINI_API_KEY     : API key Google Gemini (bắt buộc).
- TELEGRAM_BOT_TOKEN : Token của Telegram Bot (bắt buộc để gửi video).
- TELEGRAM_CHAT_ID   : Chat ID nhận video (bắt buộc để gửi video).
- PROXY_URL          : Proxy dân dụng để né Shopee chặn IP (tùy chọn).

Cách chạy: python run_bot.py
"""

import json
import os
import sys

import requests

from shopee_scraper import scrape_shopee_product
from script_generator import generate_script, get_full_voice_text
from tts_generator import text_to_speech
from video_compositor import compose_video

# File chứa danh sách link sản phẩm (mỗi dòng 1 link)
LINKS_FILE = "links.txt"

# Thư mục chứa video thành phẩm của từng link
OUTPUT_DIR = "output"


def read_links(file_path: str = LINKS_FILE) -> list:
    """
    Lấy danh sách link Shopee cần xử lý.

    Ưu tiên biến môi trường DISPATCH_LINKS (JSON array) khi workflow được kích
    hoạt từ web qua repository_dispatch; nếu không có thì đọc từ file links.txt.
    """
    dispatch_links = os.environ.get("DISPATCH_LINKS", "").strip()
    if dispatch_links and dispatch_links not in ("null", "[]"):
        try:
            links = [str(u).strip() for u in json.loads(dispatch_links) if str(u).strip()]
            if links:
                print(f"[Bot] Nhận {len(links)} link từ repository_dispatch (web).")
                return links
        except json.JSONDecodeError:
            print("[Bot] DISPATCH_LINKS không phải JSON hợp lệ, chuyển sang đọc links.txt.")

    if not os.path.exists(file_path):
        print(f"[Bot] Không tìm thấy file {file_path}!")
        return []

    links = []
    with open(file_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                links.append(line)
    return links


def upload_to_cloudinary(video_path: str, job_id: str) -> str:
    """
    Upload video lên Cloudinary với public_id = <folder>/<job_id> để frontend
    polling đúng URL. Cần secret CLOUDINARY_URL. Trả về URL video, hoặc "" nếu bỏ qua/lỗi.
    """
    if not os.environ.get("CLOUDINARY_URL", "").strip() or not job_id:
        return ""

    try:
        import cloudinary  # noqa: PLC0415 - chỉ cần khi chạy trên workflow web
        import cloudinary.uploader  # noqa: PLC0415

        folder = os.environ.get("CLOUDINARY_FOLDER", "shopee_tiktok")
        cloudinary.config(secure=True)  # đọc cấu hình từ CLOUDINARY_URL
        result = cloudinary.uploader.upload_large(
            video_path,
            resource_type="video",
            public_id=f"{folder}/{job_id}",
            overwrite=True,
        )
        url = result.get("secure_url", "")
        print(f"[Cloudinary] Đã upload video: {url}")
        return url
    except Exception as error:  # noqa: BLE001
        print(f"[Cloudinary] Lỗi khi upload: {error}")
        return ""


def send_video_to_telegram(video_path: str, caption: str) -> bool:
    """
    Gửi file video về Telegram bằng Bot API (endpoint sendVideo).
    Trả về True nếu gửi thành công.
    """
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()

    if not bot_token or not chat_id:
        print("[Telegram] Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID, bỏ qua bước gửi video.")
        return False

    url = f"https://api.telegram.org/bot{bot_token}/sendVideo"

    try:
        with open(video_path, "rb") as video_file:
            response = requests.post(
                url,
                data={
                    "chat_id": chat_id,
                    "caption": caption[:1024],  # Telegram giới hạn caption 1024 ký tự
                    "supports_streaming": True,
                },
                files={"video": video_file},
                timeout=300,  # Video có thể nặng, cho phép upload tối đa 5 phút
            )
        response.raise_for_status()
        result = response.json()
        if result.get("ok"):
            print(f"[Telegram] Đã gửi video '{video_path}' về Telegram thành công!")
            return True
        print(f"[Telegram] Telegram trả về lỗi: {result}")
        return False
    except requests.RequestException as error:
        print(f"[Telegram] Lỗi khi gửi video: {error}")
        return False


def process_link(index: int, url: str, job_id: str = "") -> bool:
    """
    Xử lý trọn vẹn 1 link sản phẩm: cào -> kịch bản -> giọng đọc -> video
    -> upload Cloudinary (nếu có) -> gửi Telegram.
    Trả về True nếu toàn bộ quy trình thành công.
    """
    print(f"\n{'=' * 60}\n[Bot] Xử lý link {index}: {url}\n{'=' * 60}")

    # Mỗi link dùng thư mục ảnh và file đầu ra riêng để không ghi đè lẫn nhau
    images_dir = os.path.join(OUTPUT_DIR, f"link_{index}", "images")
    audio_file = os.path.join(OUTPUT_DIR, f"link_{index}", "audio.mp3")
    video_file = os.path.join(OUTPUT_DIR, f"link_{index}", "final_video.mp4")
    script_file = os.path.join(OUTPUT_DIR, f"link_{index}", "script.json")
    os.makedirs(os.path.dirname(video_file), exist_ok=True)

    # ---------- BƯỚC 1: CÀO DỮ LIỆU SHOPEE ----------
    try:
        product = scrape_shopee_product(url, images_dir=images_dir)
    except Exception as error:  # noqa: BLE001 - không để 1 link lỗi làm crash cả batch
        print(f"[Bot] Lỗi khi cào dữ liệu: {error}")
        return False

    if not product.image_paths:
        print("[Bot] Không tải được ảnh sản phẩm nào, bỏ qua link này.")
        return False

    # ---------- BƯỚC 2: GEMINI VIẾT KỊCH BẢN ----------
    try:
        script = generate_script(
            product_name=product.name,
            price=product.price,
            description=product.description,
        )
        with open(script_file, "w", encoding="utf-8") as f:
            json.dump(script, f, ensure_ascii=False, indent=2)
    except Exception as error:  # noqa: BLE001
        print(f"[Bot] Lỗi khi tạo kịch bản với Gemini: {error}")
        return False

    # ---------- BƯỚC 3: TẠO GIỌNG ĐỌC ----------
    try:
        text_to_speech(get_full_voice_text(script), output_file=audio_file)
    except Exception as error:  # noqa: BLE001
        print(f"[Bot] Lỗi khi tạo giọng đọc: {error}")
        return False

    # ---------- BƯỚC 4: RENDER VIDEO ----------
    try:
        compose_video(product.image_paths, audio_file, video_file)
    except Exception as error:  # noqa: BLE001
        print(f"[Bot] Lỗi khi render video: {error}")
        return False

    # ---------- BƯỚC 5: UPLOAD CLOUDINARY (cho frontend web polling) ----------
    # Link đầu dùng đúng job_id từ web; các link sau (Premium bulk) thêm hậu tố.
    if job_id:
        public_job_id = job_id if index == 1 else f"{job_id}_{index}"
        upload_to_cloudinary(video_file, public_job_id)

    # ---------- BƯỚC 6: GỬI VỀ TELEGRAM ----------
    caption = f"🎬 Video review: {product.name}\n💰 Giá: {product.price}\n🔗 {url}"
    telegram_ok = send_video_to_telegram(video_file, caption)

    # Coi là thành công nếu video đã render (đã upload Cloudinary hoặc gửi Telegram)
    return telegram_ok or bool(job_id)


def main():
    """Điểm vào chính: xử lý lần lượt từng link trong links.txt."""
    links = read_links()
    if not links:
        print("[Bot] Không có link nào trong links.txt, kết thúc.")
        sys.exit(0)

    print(f"[Bot] Tìm thấy {len(links)} link cần xử lý.")

    job_id = os.environ.get("DISPATCH_JOB_ID", "").strip()

    success_count = 0
    for index, url in enumerate(links, start=1):
        if process_link(index, url, job_id=job_id):
            success_count += 1

    print(f"\n[Bot] HOÀN TẤT: {success_count}/{len(links)} video được tạo và gửi thành công.")

    # Trả mã lỗi khi toàn bộ link đều thất bại để GitHub Actions báo đỏ cho dễ theo dõi
    if success_count == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
