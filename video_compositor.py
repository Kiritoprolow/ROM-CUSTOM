"""
MODULE 4: VIDEO COMPOSITOR
--------------------------
Sử dụng thư viện MoviePy để ghép ảnh sản phẩm + file âm thanh thành video TikTok.

Chức năng:
- Nhận danh sách ảnh (Module 1) và file audio.mp3 (Module 3).
- Ghép ảnh thành video slide, mỗi ảnh 3-5 giây, có hiệu ứng zoom nhẹ (Ken Burns).
- Khớp tổng thời lượng ảnh với thời lượng audio.
- Xuất video dọc 9:16 (1080x1920) tên final_video.mp4.
"""

from moviepy.editor import (
    AudioFileClip,
    CompositeVideoClip,
    ImageClip,
    concatenate_videoclips,
)

# Kích thước video dọc chuẩn TikTok (9:16)
VIDEO_WIDTH = 1080
VIDEO_HEIGHT = 1920

# Giới hạn thời gian hiển thị mỗi ảnh (giây)
MIN_IMAGE_DURATION = 3.0
MAX_IMAGE_DURATION = 5.0

# File video đầu ra
OUTPUT_VIDEO = "final_video.mp4"

# Số khung hình mỗi giây
FPS = 24


def _fit_image_to_frame(clip: ImageClip) -> ImageClip:
    """
    Resize ảnh để lấp đầy khung hình dọc 9:16 mà không bị méo:
    phóng to theo chiều nhỏ hơn rồi cắt phần thừa ở giữa khung.
    """
    img_w, img_h = clip.size
    scale = max(VIDEO_WIDTH / img_w, VIDEO_HEIGHT / img_h)

    clip = clip.resize(scale)
    # Cắt chính giữa để đúng kích thước 1080x1920
    clip = clip.crop(
        x_center=clip.w / 2,
        y_center=clip.h / 2,
        width=VIDEO_WIDTH,
        height=VIDEO_HEIGHT,
    )
    return clip


def _apply_zoom_effect(clip: ImageClip, zoom_ratio: float = 0.04) -> ImageClip:
    """
    Hiệu ứng zoom nhẹ (Ken Burns): ảnh phóng to dần theo thời gian
    giúp video slide sinh động hơn thay vì ảnh tĩnh hoàn toàn.
    """
    duration = clip.duration

    def scale_at_time(t):
        # Phóng to tuyến tính từ 1.0 đến (1.0 + zoom_ratio) trong suốt thời lượng clip
        return 1 + zoom_ratio * (t / duration)

    zoomed = clip.resize(scale_at_time)
    # Đặt clip vào giữa khung hình cố định để phần zoom tràn ra ngoài bị cắt bỏ
    return CompositeVideoClip(
        [zoomed.set_position("center")],
        size=(VIDEO_WIDTH, VIDEO_HEIGHT),
    ).set_duration(duration)


def compose_video(
    image_paths: list,
    audio_path: str,
    output_file: str = OUTPUT_VIDEO,
) -> str:
    """
    Hàm chính của Module 4: ghép ảnh + audio thành video hoàn chỉnh.

    Tham số:
    - image_paths: danh sách đường dẫn ảnh sản phẩm đã tải về.
    - audio_path: đường dẫn file audio.mp3 (giọng đọc).
    - output_file: tên file video đầu ra.

    Trả về: đường dẫn file video đã xuất.
    """
    if not image_paths:
        raise ValueError("Danh sách ảnh rỗng, không thể dựng video.")

    print("[Video] Đang đọc file âm thanh...")
    audio = AudioFileClip(audio_path)
    total_duration = audio.duration

    # Tính thời lượng mỗi ảnh sao cho tổng khớp với độ dài audio,
    # đồng thời nằm trong khoảng 3-5 giây theo yêu cầu.
    num_images = len(image_paths)
    per_image = total_duration / num_images

    if per_image > MAX_IMAGE_DURATION:
        # Audio dài hơn tổng ảnh cho phép -> lặp lại danh sách ảnh cho đủ
        num_needed = int(total_duration / MAX_IMAGE_DURATION) + 1
        image_paths = [image_paths[i % num_images] for i in range(num_needed)]
        num_images = len(image_paths)
        per_image = total_duration / num_images
    elif per_image < MIN_IMAGE_DURATION:
        # Audio quá ngắn -> giảm bớt số ảnh để mỗi ảnh đủ tối thiểu 3 giây
        num_keep = max(1, int(total_duration / MIN_IMAGE_DURATION))
        image_paths = image_paths[:num_keep]
        num_images = len(image_paths)
        per_image = total_duration / num_images

    print(
        f"[Video] Dựng video từ {num_images} ảnh, "
        f"mỗi ảnh ~{per_image:.1f} giây, tổng {total_duration:.1f} giây."
    )

    # Tạo clip cho từng ảnh: resize khung dọc + hiệu ứng zoom nhẹ
    clips = []
    for path in image_paths:
        clip = ImageClip(path).set_duration(per_image)
        clip = _fit_image_to_frame(clip)
        clip = _apply_zoom_effect(clip)
        clips.append(clip)

    # Nối các clip ảnh lại thành một video slide liên tục
    video = concatenate_videoclips(clips, method="compose")

    # Cắt video đúng bằng độ dài audio và gắn audio làm giọng đọc chính
    video = video.set_duration(total_duration).set_audio(audio)

    print(f"[Video] Đang xuất video ra file '{output_file}' (có thể mất vài phút)...")
    video.write_videofile(
        output_file,
        fps=FPS,
        codec="libx264",
        audio_codec="aac",
        threads=4,
        logger=None,  # Tắt progress bar rườm rà
    )

    # Giải phóng tài nguyên
    audio.close()
    video.close()

    print(f"[Video] Hoàn tất! Video thành phẩm: {output_file}")
    return output_file


if __name__ == "__main__":
    # Chạy thử module này độc lập (cần có sẵn ảnh trong /images và audio.mp3)
    import glob

    images = sorted(glob.glob("images/*.jpg"))
    compose_video(images, "audio.mp3")
