"""
MODULE 3: TEXT-TO-SPEECH
------------------------
Sử dụng thư viện edge-tts (miễn phí, giọng đọc tự nhiên của Microsoft)
để chuyển lời thoại từ Module 2 thành file âm thanh audio.mp3.

Giọng tiếng Việt hỗ trợ:
- vi-VN-HoaiMyNeural  (giọng nữ)
- vi-VN-NamMinhNeural (giọng nam)
"""

import asyncio

import edge_tts

# Giọng đọc mặc định: giọng nữ tiếng Việt tự nhiên
DEFAULT_VOICE = "vi-VN-HoaiMyNeural"

# Tốc độ đọc: +10% để video ngắn gọn, giữ nhịp TikTok nhanh
DEFAULT_RATE = "+10%"

# File âm thanh đầu ra
OUTPUT_AUDIO = "audio.mp3"


async def _synthesize(text: str, voice: str, rate: str, output_file: str) -> None:
    """Hàm bất đồng bộ thực hiện việc chuyển text thành giọng nói."""
    communicate = edge_tts.Communicate(text=text, voice=voice, rate=rate)
    await communicate.save(output_file)


def text_to_speech(
    text: str,
    voice: str = DEFAULT_VOICE,
    rate: str = DEFAULT_RATE,
    output_file: str = OUTPUT_AUDIO,
) -> str:
    """
    Hàm chính của Module 3: chuyển lời thoại thành file mp3.

    Tham số:
    - text: lời thoại cần đọc (tiếng Việt).
    - voice: tên giọng đọc (mặc định vi-VN-HoaiMyNeural).
    - rate: tốc độ đọc (ví dụ "+10%", "-5%").
    - output_file: đường dẫn file mp3 đầu ra.

    Trả về: đường dẫn file audio đã tạo.
    """
    if not text.strip():
        raise ValueError("Lời thoại rỗng, không thể tạo giọng đọc.")

    print(f"[TTS] Đang tạo giọng đọc bằng giọng '{voice}'...")

    # edge-tts là thư viện async nên cần chạy qua asyncio.run
    asyncio.run(_synthesize(text, voice, rate, output_file))

    print(f"[TTS] Đã tạo file âm thanh: {output_file}")
    return output_file


if __name__ == "__main__":
    # Chạy thử module này độc lập
    demo_text = (
        "Xin chào các bạn! Đây là bài kiểm tra giọng đọc tiếng Việt "
        "của công cụ Shopee To TikTok Video Generator."
    )
    text_to_speech(demo_text)
