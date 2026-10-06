---
name: mbv-brand-guidelines
description: Áp dụng bộ quy chuẩn nhận diện thương hiệu MBV (Ngân hàng TNHH MTV Việt Nam Hiện Đại) — màu HEX, logo, font Liberation Sans — khi thiết kế, viết báo cáo, làm slide, banner, tài liệu hoặc trang web liên quan đến MBV. Dùng bất cứ khi nào yêu cầu nhắc đến MBV, "ngân hàng MBV", hoặc cần sản phẩm mang thương hiệu MBV. MẶC ĐỊNH đầu ra là slide .pptx 16:9 dùng để thuyết trình (kể cả khi yêu cầu ghi là "báo cáo"), trừ khi người dùng nêu rõ định dạng khác.
---

# MBV Brand Guidelines

## Đầu ra mặc định: slide thuyết trình (.pptx, 16:9)

Khi skill này được gọi (ví dụ `/mbv-brand-guidelines <chủ đề>`), **mặc định tạo file .pptx 16:9 để thuyết trình**, dùng `scripts/mbv_pptx.py`, KHÔNG tạo .docx/.pdf.
- Nội dung "báo cáo", "tài chính", "kết quả kinh doanh"… vẫn làm thành slide: mỗi slide một ý chính, câu ngắn, ưu tiên KPI/bảng gọn thay vì đoạn văn dài. Cấu trúc gợi ý: bìa → tóm tắt/thông điệp chính → các slide nội dung (KPI, bảng, so sánh) → bước tiếp theo → kết.
- Chỉ đổi sang .docx (A4 dọc), PDF, HTML… khi người dùng yêu cầu rõ định dạng đó (ví dụ "file Word", "báo cáo A4", "PDF").
- Lưu file vào thư mục `slides/` của dự án (tạo nếu chưa có), đặt tên `MBV_<ChuDe>.pptx`, rồi chạy `check_brand.py` và gửi file cho người dùng.

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

## Công cụ có sẵn (ưu tiên dùng thay vì tự viết lại)

Đường dẫn tính từ thư mục skill. Thêm `sys.path.insert(0, "<skill>/scripts")` trước khi import.

| Việc cần làm | Công cụ |
|---|---|
| Lấy màu/font/logo trong code | `scripts/mbv_brand.py` — `B.RED`, `B.GOLD`, `B.logo_path("white")`, `B.logo_for_background(hex)`, `B.register_reportlab_fonts()`, `B.draw_logo(canvas, x, y, width, mode)` |
| **Slide 16:9** (.pptx) | `scripts/mbv_pptx.py` — `new_deck()`, `add_cover`, `add_section`, `add_content`, `add_two_column`, `add_kpi`, `add_table`, `add_closing` |
| **Báo cáo A4 dọc** (.docx) | `scripts/mbv_docx.py` — `new_report()`, `add_cover`, `h1/h2/h3`, `para`, `bullets`, `callout`, `table`, `caption` |
| Web/HTML | `templates/mbv-tokens.css` (CSS variables + kiểu cơ bản) |
| Mẫu để mở/chỉnh trực tiếp | `templates/MBV_Slide_Template_16x9.pptx`, `templates/MBV_Report_Template_A4.docx` |
| **Kiểm tra trước khi giao** | `python scripts/check_brand.py <file...>` — hỗ trợ .pptx .docx .pdf .html .css .svg; báo màu ngoài bảng, font lạ, ảnh bị kéo méo, slide sai 16:9; thoát mã 1 nếu có lỗi |
| Sinh lại file mẫu | `python scripts/build_templates.py` |

Ví dụ nhanh (slide):
```python
import sys; sys.path.insert(0, "<skill>/scripts")
import mbv_pptx as S
prs = S.new_deck()
S.add_cover(prs, "Báo cáo quý III", "Khối Bán lẻ", "30/09/2026")
S.add_content(prs, "Điểm nổi bật", ["Ý chính", ("Ý phụ", 1)])
S.add_kpi(prs, "Chỉ số chính", [("1.250 tỷ", "Huy động"), ("18%", "Tăng trưởng")])
S.add_closing(prs)
prs.save("bao-cao.pptx")
```
Ví dụ nhanh (báo cáo): `doc = D.new_report(); D.add_cover(doc, "Tiêu đề", "Phụ đề", "Đơn vị · ngày"); D.h1(doc, "1. Tổng quan"); D.para(doc, "..."); D.table(doc, ["Chỉ tiêu","Q2","Q3"], rows); doc.save("bao-cao.docx")`

Giới hạn cần biết: các builder chỉ dựng bố cục cơ bản; nếu cần bố cục đặc thù vẫn dùng các hàm nhỏ trong module và giữ nguyên bảng màu/font. Nếu môi trường không có font Liberation Sans, file .pptx/.docx vẫn ghi đúng tên font và máy người xem sẽ tự thay bằng Arial.

## Quy trình

1. Xác định định dạng đầu ra: mặc định slide .pptx 16:9; chỉ chọn A4 dọc / PDF / web / khác khi người dùng yêu cầu rõ.
2. Dùng builder hoặc template ở trên; không tự thêm màu/font khác bảng chuẩn.
3. Chạy `check_brand.py` trên file đầu ra và sửa hết lỗi; với file trực quan, mở/render để kiểm tra bố cục, dấu tiếng Việt, tương phản.
4. Nếu sản phẩm để công bố bên ngoài, nhắc người dùng đối chiếu với tài sản thương hiệu gốc của MBV.
