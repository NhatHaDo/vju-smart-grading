# Font cho phần tóm tắt điểm in lên ảnh overlay

`debug_overlay.py` (hàm `draw_section_score_summary`) sẽ dùng file
**`score_summary.ttf`** trong chính thư mục này nếu có, để khớp đúng font
"Be Vietnam Pro" mà web đang dùng (xem `frontend/index.html`).

## Cách thêm (không bắt buộc — thiếu file này thì code tự rơi về font hệ
thống macOS/Linux có sẵn, vẫn đẹp hơn nhiều so với font mặc định của OpenCV):

1. Vào <https://fonts.google.com/specimen/Be+Vietnam+Pro> → bấm **Download family**.
2. Giải nén, tìm file **`BeVietnamPro-Bold.ttf`**.
3. Đổi tên thành **`score_summary.ttf`**, copy vào đúng thư mục này
   (`backend/app/core/omr/assets/fonts/score_summary.ttf`).
4. Khởi động lại backend.
