"""
GIAO DIỆN WEB APP - SHOPEE TO TIKTOK VIDEO GENERATOR
====================================================
Giao diện Streamlit thân thiện: dán link Shopee -> bấm nút -> nhận video TikTok.

Cách chạy:
    export GEMINI_API_KEY='your_key'
    streamlit run app.py
"""

import json
import os

import streamlit as st

from shopee_scraper import scrape_shopee_product
from script_generator import generate_script, get_full_voice_text
from tts_generator import text_to_speech
from video_compositor import compose_video

# File kết quả đầu ra
SCRIPT_FILE = "script.json"
VIDEO_FILE = "final_video.mp4"

# Nhãn hiển thị tiếng Việt cho từng phân đoạn kịch bản
SECTION_LABELS = {
    "hook": "🎯 Hook (Mở đầu thu hút)",
    "problem": "😰 Problem (Vấn đề)",
    "features": "✨ Features (Tính năng nổi bật)",
    "cta": "🛒 CTA (Kêu gọi hành động)",
}

# Cấu hình trang: tiêu đề tab và layout căn giữa
st.set_page_config(page_title="Shopee To TikTok Video Generator", page_icon="🚀")


def render_script(script: dict) -> None:
    """Hiển thị kịch bản Gemini đã viết ra màn hình cho người dùng đọc lại."""
    st.subheader("📜 Kịch bản AI đã viết")
    for key, label in SECTION_LABELS.items():
        section = script.get(key, {})
        with st.expander(label, expanded=True):
            st.markdown(f"**Lời thoại:** {section.get('voice', '')}")
            st.caption(f"Phân cảnh: {section.get('visual', '')}")


def run_pipeline(product_url: str) -> None:
    """Chạy toàn bộ quy trình 4 bước và hiển thị trạng thái từng bước."""

    # ---------- BƯỚC 1: CÀO DỮ LIỆU SHOPEE ----------
    with st.spinner("🔍 Đang cào dữ liệu Shopee..."):
        product = scrape_shopee_product(product_url)
    if not product.image_paths:
        st.error("Không tải được ảnh sản phẩm nào — Shopee có thể đang chặn bot. Hãy thử lại hoặc dùng link khác.")
        st.stop()
    st.success(f"✅ Đã cào xong: **{product.name}** — Giá: {product.price} — {len(product.image_paths)} ảnh")

    # ---------- BƯỚC 2: AI VIẾT KỊCH BẢN ----------
    with st.spinner("🤖 Đang nhờ AI viết kịch bản..."):
        script = generate_script(
            product_name=product.name,
            price=product.price,
            description=product.description,
        )
        with open(SCRIPT_FILE, "w", encoding="utf-8") as f:
            json.dump(script, f, ensure_ascii=False, indent=2)
    st.success("✅ Kịch bản đã sẵn sàng!")

    # ---------- BƯỚC 3: TẠO GIỌNG ĐỌC ----------
    with st.spinner("🎙️ Đang tạo giọng đọc..."):
        audio_file = text_to_speech(get_full_voice_text(script))
    st.success("✅ Đã tạo giọng đọc AI tiếng Việt!")

    # ---------- BƯỚC 4: RENDER VIDEO ----------
    with st.spinner("🎬 Đang render video (có thể mất vài phút)..."):
        video_file = compose_video(product.image_paths, audio_file, VIDEO_FILE)
    st.success("✅ Video đã render xong!")

    # Lưu kết quả vào session_state để không bị mất khi Streamlit rerun
    st.session_state["script"] = script
    st.session_state["video_file"] = video_file


def main():
    # 1. Tiêu đề chính: căn giữa, định dạng lớn
    st.markdown(
        "<h1 style='text-align: center;'>SHOPEE TO TIKTOK VIDEO GENERATOR 🚀</h1>",
        unsafe_allow_html=True,
    )
    st.markdown(
        "<p style='text-align: center;'>Dán link sản phẩm Shopee → AI tự động tạo video TikTok Affiliate hoàn chỉnh</p>",
        unsafe_allow_html=True,
    )
    st.divider()

    # Cảnh báo sớm nếu chưa cấu hình API key Gemini
    if not os.environ.get("GEMINI_API_KEY"):
        st.warning(
            "⚠️ Chưa thiết lập biến môi trường `GEMINI_API_KEY`. "
            "Lấy key miễn phí tại https://aistudio.google.com/app/apikey rồi chạy lại app."
        )

    # 2. Ô nhập link sản phẩm Shopee
    product_url = st.text_input(
        "🔗 Link sản phẩm Shopee",
        placeholder="https://shopee.vn/ten-san-pham-i.12345678.87654321",
    )

    # 3. Nút bắt đầu tạo video
    if st.button("BẮT ĐẦU TẠO VIDEO 🎬", type="primary", use_container_width=True):
        if not product_url.strip():
            st.error("Vui lòng dán link sản phẩm Shopee trước khi bấm nút!")
        else:
            # Xóa kết quả cũ trước khi chạy lần mới
            st.session_state.pop("script", None)
            st.session_state.pop("video_file", None)
            # 4. Vùng trạng thái: chạy pipeline với spinner từng bước
            try:
                run_pipeline(product_url.strip())
            except Exception as error:  # noqa: BLE001 - hiển thị mọi lỗi lên UI thay vì crash app
                st.error(f"❌ Có lỗi xảy ra: {error}")

    # 5. Khu vực hiển thị kết quả (giữ nguyên sau mỗi lần rerun nhờ session_state)
    if "script" in st.session_state and "video_file" in st.session_state:
        st.divider()
        render_script(st.session_state["script"])

        video_path = st.session_state["video_file"]
        if os.path.exists(video_path):
            st.subheader("🎥 Video thành phẩm")
            st.video(video_path)

            # Nút tải video về máy
            with open(video_path, "rb") as f:
                st.download_button(
                    label="⬇️ TẢI VIDEO VỀ MÁY",
                    data=f,
                    file_name="final_video.mp4",
                    mime="video/mp4",
                    use_container_width=True,
                )


if __name__ == "__main__":
    main()
