"""
MODULE 1: SHOPEE SCRAPER
------------------------
Cào dữ liệu sản phẩm Shopee bằng Playwright (trình duyệt thật, tránh bị chặn bot).

Chức năng:
- Nhận vào link sản phẩm Shopee.
- Tự động cấu hình User-Agent giống người dùng thật để tránh bị Shopee chặn.
- Cào: Tên sản phẩm, Giá, Mô tả, Danh sách link hình ảnh.
- Tải tối đa 5-7 ảnh chất lượng cao về thư mục /images.
"""

import os
import re
import json
from dataclasses import dataclass, field

import requests
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

# User-Agent giả lập trình duyệt Chrome trên Windows để tránh bị chặn bot
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36"
)

# Thư mục lưu ảnh sản phẩm tải về
IMAGES_DIR = "images"

# Số ảnh tối đa cần tải
MAX_IMAGES = 7


@dataclass
class ProductData:
    """Cấu trúc dữ liệu sản phẩm sau khi cào."""

    name: str = ""
    price: str = ""
    description: str = ""
    image_urls: list = field(default_factory=list)
    image_paths: list = field(default_factory=list)  # Đường dẫn ảnh đã tải về máy


def _parse_shopee_url(url: str):
    """
    Phân tích link Shopee để lấy shop_id và item_id.
    Hỗ trợ 2 dạng link phổ biến:
    - https://shopee.vn/ten-san-pham-i.SHOPID.ITEMID
    - https://shopee.vn/product/SHOPID/ITEMID
    """
    match = re.search(r"i\.(\d+)\.(\d+)", url)
    if match:
        return match.group(1), match.group(2)

    match = re.search(r"/product/(\d+)/(\d+)", url)
    if match:
        return match.group(1), match.group(2)

    return None, None


def _upgrade_image_url(url: str) -> str:
    """
    Chuyển link ảnh thumbnail của Shopee thành link ảnh chất lượng cao.
    Shopee thường thêm hậu tố như '_tn' hoặc resize param vào link thumbnail.
    """
    # Bỏ hậu tố thumbnail "_tn" nếu có
    url = re.sub(r"_tn(\.\w+)?$", r"\1", url)
    # Bỏ tham số resize dạng @resize_...
    url = re.sub(r"@resize_w\d+_nl.*$", "", url)
    return url


def _extract_from_api_response(data: dict) -> ProductData:
    """
    Trích xuất thông tin sản phẩm từ JSON API nội bộ của Shopee (endpoint get_pc).
    """
    product = ProductData()
    item = data.get("data", {}).get("item", {}) or data.get("item", {}) or {}

    product.name = item.get("title") or item.get("name") or ""

    # Giá của Shopee được nhân với 100000, cần chia lại để ra giá thật (VND)
    raw_price = item.get("price") or item.get("price_min") or 0
    if raw_price:
        product.price = f"{int(raw_price / 100000):,}đ".replace(",", ".")

    product.description = item.get("description") or ""

    # Danh sách ảnh: Shopee trả về mã hash ảnh, cần ghép với CDN domain
    images = item.get("images") or []
    for img_hash in images[:MAX_IMAGES]:
        product.image_urls.append(f"https://down-vn.img.susercontent.com/file/{img_hash}")

    return product


def _extract_from_dom(page) -> ProductData:
    """
    Phương án dự phòng: trích xuất thông tin sản phẩm trực tiếp từ DOM của trang
    khi không bắt được API nội bộ.
    """
    product = ProductData()

    # Lấy tên sản phẩm từ thẻ h1 hoặc meta og:title
    try:
        title_el = page.query_selector("h1")
        if title_el:
            product.name = title_el.inner_text().strip()
        if not product.name:
            meta = page.query_selector('meta[property="og:title"]')
            if meta:
                product.name = meta.get_attribute("content") or ""
    except PlaywrightTimeoutError:
        pass

    # Lấy mô tả từ meta og:description
    meta_desc = page.query_selector('meta[property="og:description"]')
    if meta_desc:
        product.description = meta_desc.get_attribute("content") or ""

    # Lấy giá: tìm các phần tử chứa ký hiệu tiền tệ ₫
    price_el = page.query_selector("div[class*='price'], span[class*='price']")
    if price_el:
        product.price = price_el.inner_text().strip()

    # Lấy link ảnh từ các thẻ img trỏ tới CDN của Shopee
    for img in page.query_selector_all("img"):
        src = img.get_attribute("src") or ""
        if "susercontent.com/file/" in src:
            high_quality = _upgrade_image_url(src)
            if high_quality not in product.image_urls:
                product.image_urls.append(high_quality)
        if len(product.image_urls) >= MAX_IMAGES:
            break

    return product


def download_images(image_urls: list, output_dir: str = IMAGES_DIR) -> list:
    """
    Tải danh sách ảnh về thư mục output_dir.
    Trả về danh sách đường dẫn file ảnh đã tải thành công.
    """
    os.makedirs(output_dir, exist_ok=True)
    saved_paths = []

    headers = {"User-Agent": USER_AGENT, "Referer": "https://shopee.vn/"}

    for index, url in enumerate(image_urls[:MAX_IMAGES], start=1):
        try:
            response = requests.get(url, headers=headers, timeout=30)
            response.raise_for_status()

            file_path = os.path.join(output_dir, f"product_{index}.jpg")
            with open(file_path, "wb") as f:
                f.write(response.content)

            saved_paths.append(file_path)
            print(f"  [Scraper] Đã tải ảnh {index}: {file_path}")
        except requests.RequestException as error:
            print(f"  [Scraper] Lỗi khi tải ảnh {url}: {error}")

    return saved_paths


def scrape_shopee_product(url: str) -> ProductData:
    """
    Hàm chính của Module 1: nhận link Shopee, trả về ProductData đầy đủ
    (tên, giá, mô tả, link ảnh và ảnh đã tải về máy).
    """
    print(f"[Scraper] Bắt đầu cào dữ liệu từ: {url}")
    product = ProductData()
    api_payload = {}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent=USER_AGENT,
            viewport={"width": 1366, "height": 768},
            locale="vi-VN",
        )
        page = context.new_page()

        def handle_response(response):
            """Bắt gói tin API nội bộ của Shopee chứa dữ liệu sản phẩm."""
            if "/api/v4/pdp/get_pc" in response.url or "/api/v4/item/get" in response.url:
                try:
                    api_payload.update(response.json())
                except (json.JSONDecodeError, ValueError):
                    pass

        page.on("response", handle_response)

        try:
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            # Chờ thêm để trang render và các API nội bộ được gọi xong
            page.wait_for_timeout(8000)
        except PlaywrightTimeoutError:
            print("[Scraper] Trang tải chậm, tiếp tục với dữ liệu hiện có...")

        # Ưu tiên dữ liệu từ API nội bộ (đầy đủ và chính xác hơn)
        if api_payload:
            product = _extract_from_api_response(api_payload)

        # Nếu API không có dữ liệu thì fallback sang đọc DOM
        if not product.name:
            product = _extract_from_dom(page)

        browser.close()

    if not product.name:
        raise RuntimeError(
            "Không cào được dữ liệu sản phẩm. Shopee có thể đang chặn bot "
            "hoặc yêu cầu đăng nhập. Hãy thử lại hoặc dùng link khác."
        )

    print(f"[Scraper] Tên sản phẩm: {product.name}")
    print(f"[Scraper] Giá: {product.price}")
    print(f"[Scraper] Số ảnh tìm thấy: {len(product.image_urls)}")

    # Tải ảnh về thư mục /images
    product.image_paths = download_images(product.image_urls)

    return product


if __name__ == "__main__":
    # Chạy thử module này độc lập
    test_url = input("Nhập link sản phẩm Shopee: ").strip()
    result = scrape_shopee_product(test_url)
    print(json.dumps(result.__dict__, ensure_ascii=False, indent=2))
