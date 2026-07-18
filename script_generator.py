"""
MODULE 2: AI SCRIPT GENERATOR
-----------------------------
Sử dụng Google Gemini API (model gemini-1.5-flash) để viết kịch bản video TikTok.

Chức năng:
- Nhận dữ liệu sản phẩm từ Module 1 (tên, giá, mô tả).
- Gửi cho Gemini với System Prompt ép trả về JSON sạch.
- Trả về dict gồm 4 phân đoạn: hook, problem, features, cta.
  Mỗi phân đoạn có "voice" (lời thoại) và "visual" (mô tả phân cảnh).
"""

import os
import json
import re

import google.generativeai as genai

# Tên model Gemini sử dụng (miễn phí, tốc độ nhanh)
GEMINI_MODEL = "gemini-1.5-flash"

# System Prompt: ép Gemini đóng vai chuyên gia content TikTok và CHỈ trả về JSON
SYSTEM_PROMPT = """Bạn là chuyên gia viết kịch bản video TikTok Affiliate tại Việt Nam.
Nhiệm vụ: đọc thông tin sản phẩm và viết kịch bản video TikTok dưới 60 giây.

YÊU CẦU BẮT BUỘC:
1. CHỈ trả về một chuỗi JSON hợp lệ, KHÔNG thêm bất kỳ văn bản, giải thích hay markdown nào khác.
2. JSON phải có đúng cấu trúc sau:
{
  "hook": {"voice": "...", "visual": "..."},
  "problem": {"voice": "...", "visual": "..."},
  "features": {"voice": "...", "visual": "..."},
  "cta": {"voice": "...", "visual": "..."}
}
3. Ý nghĩa từng phần:
   - hook: 1-2 câu mở đầu gây sốc/tò mò trong 3 giây đầu để giữ chân người xem.
   - problem: nêu vấn đề, nỗi đau mà người xem đang gặp phải.
   - features: giới thiệu 2-3 tính năng nổi bật nhất của sản phẩm và mức giá.
   - cta: kêu gọi hành động (bấm giỏ hàng, mua ngay, số lượng có hạn...).
4. "voice" là lời thoại tiếng Việt tự nhiên, thân thiện, dùng ngôn ngữ nói (sẽ được đọc bằng AI).
5. "visual" là mô tả ngắn gọn phân cảnh hình ảnh tương ứng.
6. Tổng thời lượng đọc toàn bộ "voice" phải dưới 60 giây (khoảng 120-150 từ)."""


def _clean_json_response(raw_text: str) -> str:
    """
    Làm sạch chuỗi trả về từ Gemini: loại bỏ markdown code fence (```json ... ```)
    và cắt lấy đúng phần JSON từ dấu { đầu tiên đến dấu } cuối cùng.
    """
    # Bỏ code fence markdown nếu có
    text = re.sub(r"```(?:json)?", "", raw_text).strip()

    # Cắt lấy phần từ { đầu tiên đến } cuối cùng
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        text = text[start : end + 1]

    return text


def generate_script(product_name: str, price: str, description: str) -> dict:
    """
    Hàm chính của Module 2: gọi Gemini API để sinh kịch bản TikTok.

    Trả về dict dạng:
    {
      "hook": {"voice": "...", "visual": "..."},
      "problem": {"voice": "...", "visual": "..."},
      "features": {"voice": "...", "visual": "..."},
      "cta": {"voice": "...", "visual": "..."}
    }
    """
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "Chưa thiết lập biến môi trường GEMINI_API_KEY. "
            "Lấy API key miễn phí tại https://aistudio.google.com/app/apikey "
            "rồi chạy: export GEMINI_API_KEY='your_key'"
        )

    # Cấu hình API key cho thư viện google-generativeai
    genai.configure(api_key=api_key)

    model = genai.GenerativeModel(
        model_name=GEMINI_MODEL,
        system_instruction=SYSTEM_PROMPT,
    )

    # Nội dung gửi cho Gemini: thông tin sản phẩm đã cào được
    user_prompt = f"""Thông tin sản phẩm cần viết kịch bản:
- Tên sản phẩm: {product_name}
- Giá bán: {price}
- Mô tả: {description[:2000]}

Hãy viết kịch bản TikTok theo đúng cấu trúc JSON đã yêu cầu."""

    print("[AI Script] Đang gọi Gemini API để viết kịch bản...")
    response = model.generate_content(user_prompt)

    cleaned = _clean_json_response(response.text)

    try:
        script = json.loads(cleaned)
    except json.JSONDecodeError as error:
        raise RuntimeError(
            f"Gemini trả về JSON không hợp lệ: {error}\nNội dung nhận được:\n{response.text}"
        ) from error

    # Kiểm tra đủ 4 key bắt buộc
    required_keys = ["hook", "problem", "features", "cta"]
    for key in required_keys:
        if key not in script:
            raise RuntimeError(f"Kịch bản thiếu phần bắt buộc: '{key}'")

    print("[AI Script] Đã tạo kịch bản thành công!")
    for key in required_keys:
        print(f"  - {key.upper()}: {script[key].get('voice', '')[:80]}...")

    return script


def get_full_voice_text(script: dict) -> str:
    """
    Ghép toàn bộ lời thoại của 4 phân đoạn thành một đoạn text duy nhất
    để đưa vào Module 3 (Text-to-Speech).
    """
    parts = []
    for key in ["hook", "problem", "features", "cta"]:
        voice = script.get(key, {}).get("voice", "").strip()
        if voice:
            parts.append(voice)
    return " ".join(parts)


if __name__ == "__main__":
    # Chạy thử module này độc lập với dữ liệu mẫu
    demo_script = generate_script(
        product_name="Tai nghe Bluetooth ABC Pro",
        price="299.000đ",
        description="Tai nghe không dây, pin 30 giờ, chống ồn chủ động, chống nước IPX5.",
    )
    print(json.dumps(demo_script, ensure_ascii=False, indent=2))
    print("\nLời thoại đầy đủ:\n", get_full_voice_text(demo_script))
