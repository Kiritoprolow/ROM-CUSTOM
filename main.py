"""
SHOPEE TO TIKTOK VIDEO GENERATOR
================================
Tool tự động: Link Shopee -> Cào dữ liệu -> AI viết kịch bản -> Giọng đọc AI
-> Video TikTok hoàn chỉnh (final_video.mp4) để làm Affiliate.

Cách chạy:
    export GEMINI_API_KEY='your_key'   # Lấy key miễn phí tại aistudio.google.com
    python main.py

Quy trình 4 bước:
    1. Module 1 (shopee_scraper): cào tên, giá, mô tả, ảnh sản phẩm.
    2. Module 2 (script_generator): Gemini viết kịch bản TikTok dạng JSON.
    3. Module 3 (tts_generator): edge-tts chuyển lời thoại thành audio.mp3.
    4. Module 4 (video_compositor): MoviePy dựng video dọc 9:16 final_video.mp4.
"""

import json
import sys

from shopee_scraper import scrape_shopee_product
from script_generator import generate_script, get_full_voice_text
from tts_generator import text_to_speech
from video_compositor import compose_video

# File lưu lại kịch bản để người dùng xem lại / chỉnh sửa
SCRIPT_FILE = "script.json"


def main():
    """Hàm điều phối chính: liên kết 4 module thành một quy trình tự động."""
    print("=" * 60)
    print("   SHOPEE TO TIKTOK VIDEO GENERATOR")
    print("=" * 60)

    # Nhận link sản phẩm từ tham số dòng lệnh hoặc hỏi trực tiếp người dùng
    if len(sys.argv) > 1:
        product_url = sys.argv[1].strip()
    else:
        product_url = input("\nNhập link sản phẩm Shopee: ").strip()

    if not product_url:
        print("Lỗi: Bạn chưa nhập link sản phẩm!")
        sys.exit(1)

    # ---------- BƯỚC 1: CÀO DỮ LIỆU SHOPEE ----------
    print("\n[BƯỚC 1/4] Cào dữ liệu sản phẩm từ Shopee...")
    product = scrape_shopee_product(product_url)

    if not product.image_paths:
        print("Lỗi: Không tải được ảnh sản phẩm nào, không thể dựng video.")
        sys.exit(1)

    # ---------- BƯỚC 2: AI VIẾT KỊCH BẢN ----------
    print("\n[BƯỚC 2/4] Gemini AI đang viết kịch bản TikTok...")
    script = generate_script(
        product_name=product.name,
        price=product.price,
        description=product.description,
    )

    # Lưu kịch bản ra file để người dùng tham khảo phần "visual" khi cần chỉnh video
    with open(SCRIPT_FILE, "w", encoding="utf-8") as f:
        json.dump(script, f, ensure_ascii=False, indent=2)
    print(f"[AI Script] Kịch bản đã lưu tại: {SCRIPT_FILE}")

    # ---------- BƯỚC 3: TẠO GIỌNG ĐỌC ----------
    print("\n[BƯỚC 3/4] Chuyển kịch bản thành giọng đọc AI...")
    voice_text = get_full_voice_text(script)
    audio_file = text_to_speech(voice_text)

    # ---------- BƯỚC 4: DỰNG VIDEO ----------
    print("\n[BƯỚC 4/4] Dựng video TikTok hoàn chỉnh...")
    video_file = compose_video(product.image_paths, audio_file)

    print("\n" + "=" * 60)
    print("   HOÀN TẤT!")
    print(f"   - Kịch bản : {SCRIPT_FILE}")
    print(f"   - Âm thanh : {audio_file}")
    print(f"   - Video    : {video_file}")
    print("=" * 60)


if __name__ == "__main__":
    main()
