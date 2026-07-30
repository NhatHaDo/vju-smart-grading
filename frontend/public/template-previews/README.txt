Đặt ảnh chụp/scan thật của từng mẫu phiếu VJU vào đúng thư mục này, đúng tên file bên dưới — trang Upload & Answer Key sẽ tự động hiển thị ảnh thay cho danh sách trường/phần câu hỏi ngay khi có file, không cần sửa code:

  vju-sbd4.jpg   → Mẫu phiếu VJU - SBD 4 số
  vju-sbd8.jpg   → Mẫu phiếu VJU - SBD 8 số
  vju-mau40.jpg  → Mẫu 40 câu TN + Đúng/Sai

Có thể dùng .png/.webp thay .jpg — chỉ cần sửa lại đúng đuôi file trong
frontend/src/types/grading.ts (VJU_SBD4_PREVIEW_IMAGE / VJU_SBD8_PREVIEW_IMAGE / PINNED_TEMPLATE_40_PREVIEW_IMAGE).
