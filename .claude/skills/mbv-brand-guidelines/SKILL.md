---
name: mbv-brand-guidelines
description: Áp dụng bộ quy chuẩn nhận diện thương hiệu MBV (Ngân hàng TNHH MTV Việt Nam Hiện Đại) — màu HEX, logo, font Liberation Sans — khi thiết kế, viết báo cáo, làm slide, banner, tài liệu hoặc trang web liên quan đến MBV. Dùng bất cứ khi nào yêu cầu nhắc đến MBV, "ngân hàng MBV", hoặc cần sản phẩm mang thương hiệu MBV.
---

# MBV Brand Guidelines

Áp dụng các quy chuẩn dưới đây cho mọi sản phẩm mang thương hiệu MBV (thiết kế, báo cáo, slide, tài liệu, HTML/PDF/DOCX/PPTX). Nếu người dùng đưa quy chuẩn khác/mới hơn, ưu tiên theo người dùng.

> Lưu ý: bộ quy chuẩn này là bản tổng hợp không chính thức. Màu HEX lấy mẫu từ logo; CMYK là quy đổi gần đúng; font là lựa chọn của người dùng. Khi in ấn/bảng hiệu cần đối chiếu với tài sản gốc của MBV.

## Màu sắc

| Tên | HEX | CMYK (gần đúng) | Dùng cho |
|---|---|---|---|
| MBV Red | `#B61D22` | C15 M100 Y95 K8 | Màu chủ đạo: tiêu đề, nền nhấn, nút, wordmark |
| Deep Red | `#8A1418` | C25 M100 Y100 K45 | Hover, nền tối phụ, đổ bóng |
| Star Gold | `#FCC743` | C0 M25 Y80 K0 | Điểm nhấn, ngôi sao, số liệu nổi bật |
| Ink | `#1C1C1E` | C70 M65 Y60 K85 | Chữ chính |
| Stone | `#F4F1EC` | C3 M4 Y8 K0 | Nền phụ, thẻ, khối |
| White | `#FFFFFF` | — | Nền chính |
| Grey | `#6B6B70` | — | Chữ phụ, chú thích |
| Line | `#D9D5CE` | — | Đường kẻ, viền |

Tỷ lệ tham khảo: Trắng ~50% · Đỏ ~25% · Stone ~12% · Ink ~8% · Vàng ~5%.
- Vàng chỉ là điểm nhấn; không dùng vàng làm màu chữ trên nền trắng (độ tương phản thấp). Chữ trên nền vàng dùng Ink.
- Chữ trên nền đỏ dùng trắng.
- Biểu đồ: dùng Red làm màu chính, Gold/Ink/Grey làm màu phụ; không thêm màu lạ ngoài bảng (xanh dương, xanh lá…) trừ khi dữ liệu bắt buộc.

## Logo

Logo gồm wordmark **MBV** (đỏ đậm, nét loe nhẹ) và **ngôi sao vàng năm cánh đan từ các dải song song** ở góc trên bên phải chữ. Tệp có sẵn trong `assets/` (PNG nền trong suốt, tỷ lệ 1055×425):

- `logo_color.png` — bản chuẩn: dùng trên nền trắng/sáng
- `logo_white.png` — chữ trắng, sao vàng: dùng trên nền đỏ hoặc nền tối
- `logo_mono.png` — đơn sắc đen: nền vàng, in đen trắng, fax
- `logo_red.png` — một màu đỏ: nền sáng khi cần một màu
- `star_color.png` / `star_white.png` — chỉ ngôi sao, dùng làm họa tiết/icon app/điểm nhấn

Quy tắc:
- Giữ nguyên tỷ lệ; chừa vùng an toàn quanh logo tối thiểu bằng chiều cao chữ M.
- Kích thước tối thiểu: rộng 24 mm khi in / 96 px trên màn hình.
- Không kéo giãn, xoay, đổi màu, thêm bóng/viền, hay đặt trên nền nhiễu/thiếu tương phản.
- Đặt logo ở góc trên trái hoặc trang bìa; mỗi trang/slide tối đa một logo lớn. Ngôi sao dùng làm họa tiết không quá 1–2 lần mỗi trang.
- Không tự vẽ lại logo bằng chữ + hình sao; luôn dùng file trong `assets/`. Nếu không chèn được ảnh, ghi rõ chỗ đặt logo thay vì giả lập.

## Font chữ

- **Liberation Sans** (Regular, Bold, Italic) cho toàn bộ tiêu đề và nội dung; hỗ trợ đầy đủ tiếng Việt. Dự phòng: Arial, Helvetica, sans-serif.
- CSS: `font-family: "Liberation Sans", Arial, Helvetica, sans-serif;`
- Trong ReportLab: đăng ký `/usr/share/fonts/truetype/liberation/LiberationSans-{Regular,Bold,Italic}.ttf`. Trong python-pptx/python-docx: đặt tên font `Liberation Sans` (máy người xem thiếu font sẽ tự thay bằng Arial).
- Cấp bậc gợi ý: H1 28–32 pt Bold Ink (hoặc Red) · H2 18–22 pt Bold · Body 10.5–12 pt Regular Ink · Caption 8.5–9 pt Grey.
- Tối đa 2 độ đậm (Regular + Bold); tiêu đề căn trái; giãn dòng 1.4–1.5; không viết hoa toàn bộ cho đoạn văn.

## Áp dụng theo loại sản phẩm

**Báo cáo / tài liệu**: trang bìa nền đỏ (`#B61D22`) + logo trắng + sao vàng lớn làm họa tiết; nội thất nền trắng, thanh đỏ mỏng trên đầu trang, tiêu đề Bold, số trang và chân trang màu Grey. Bảng: hàng tiêu đề nền đỏ chữ trắng, hàng xen kẽ Stone.

**Slide**: slide tiêu đề nền đỏ + logo trắng; slide nội dung nền trắng, tiêu đề Ink/Red, logo nhỏ góc trên phải hoặc chân trang; một ý chính mỗi slide; số liệu nổi bật dùng Red hoặc Gold trên nền Ink/Red.

**Banner / thiết kế đồ họa**: nền đỏ hoặc trắng, tiêu đề Bold, nút CTA nền vàng chữ Ink bo tròn, ngôi sao vàng làm họa tiết lớn cắt góc.

**Web / HTML**: định nghĩa CSS variables `--mbv-red:#B61D22; --mbv-deep-red:#8A1418; --mbv-gold:#FCC743; --mbv-ink:#1C1C1E; --mbv-stone:#F4F1EC;`. Kiểm tra độ tương phản văn bản (≥ 4.5:1).

**Văn phong**: tiếng Việt, rõ ràng, tự tin, gần gũi; tránh thuật ngữ khó hiểu; thể hiện các giá trị tiên phong – nhiệt huyết – hiện đại – tin cậy. Tên đầy đủ: Ngân hàng TNHH MTV Việt Nam Hiện Đại (Modern Bank of Vietnam), viết tắt MBV; thành viên hệ sinh thái MB Group. Không bịa số liệu, lãi suất hay slogan chính thức của MBV.

## Quy trình

1. Xác định loại sản phẩm và định dạng đầu ra.
2. Dùng màu HEX, font và file logo ở trên; không tự thêm màu/font khác.
3. Kiểm tra lại: đúng màu, logo đúng bản theo nền, vùng an toàn, tương phản, font hiển thị đủ dấu tiếng Việt.
4. Nếu sản phẩm để công bố bên ngoài, nhắc người dùng đối chiếu với tài sản thương hiệu gốc của MBV.
