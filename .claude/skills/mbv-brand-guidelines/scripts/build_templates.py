#!/usr/bin/env python3
"""Sinh lại file mẫu trong templates/ từ các module builder."""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import mbv_brand as B
import mbv_docx as D
import mbv_pptx as S

OUT = os.path.join(B.SKILL_DIR, "templates")
os.makedirs(OUT, exist_ok=True)

prs = S.new_deck()
S.add_cover(prs, "Tiêu đề bài trình bày", "Phụ đề / đơn vị trình bày", "DD/MM/YYYY")
S.add_section(prs, "Tên phần", "Mô tả ngắn")
S.add_content(prs, "Tiêu đề slide nội dung", ["Ý chính thứ nhất", ("Ý phụ", 1), "Ý chính thứ hai", "Ý chính thứ ba"])
S.add_two_column(prs, "So sánh hai nhóm", "Nhóm A", ["Điểm 1", "Điểm 2"], "Nhóm B", ["Điểm 1", "Điểm 2"])
S.add_kpi(prs, "Chỉ số chính", [("0.000 tỷ", "Chỉ số 1"), ("00%", "Chỉ số 2"), ("0.000", "Chỉ số 3")],
          "Ghi chú nguồn số liệu.")
S.add_table(prs, "Bảng số liệu", ["Chỉ tiêu", "Kỳ trước", "Kỳ này"], [["Chỉ tiêu A", "0", "0"], ["Chỉ tiêu B", "0", "0"], ["Chỉ tiêu C", "0", "0"]])
S.add_closing(prs, "Xin cảm ơn", "Liên hệ: email@mbv.com.vn")
prs.save(os.path.join(OUT, "MBV_Slide_Template_16x9.pptx"))

doc = D.new_report()
D.add_cover(doc, "Tiêu đề báo cáo", "Phụ đề báo cáo", "Đơn vị · DD/MM/YYYY")
D.h1(doc, "1. Tổng quan")
D.para(doc, "Nội dung đoạn văn mẫu. Dùng Liberation Sans 11 pt, giãn dòng 1.4, căn trái.")
D.bullets(doc, ["Ý chính thứ nhất", "Ý chính thứ hai"])
D.callout(doc, "Thông điệp quan trọng cần nhấn mạnh.", "Lưu ý")
D.h2(doc, "1.1. Số liệu")
D.table(doc, ["Chỉ tiêu", "Kỳ trước", "Kỳ này"], [["Chỉ tiêu A", "0", "0"], ["Chỉ tiêu B", "0", "0"], ["Chỉ tiêu C", "0", "0"]], [8.6, 4, 4])
D.caption(doc, "Bảng 1. Nguồn: ...")
doc.save(os.path.join(OUT, "MBV_Report_Template_A4.docx"))

css = """/* MBV design tokens */
:root{
  --mbv-red:#B61D22; --mbv-deep-red:#8A1418; --mbv-gold:#FCC743;
  --mbv-ink:#1C1C1E; --mbv-stone:#F4F1EC; --mbv-white:#FFFFFF;
  --mbv-grey:#6B6B70; --mbv-line:#D9D5CE;
  --mbv-font:"Liberation Sans", Arial, Helvetica, sans-serif;
}
body{font-family:var(--mbv-font);color:var(--mbv-ink);background:var(--mbv-white);line-height:1.5}
h1,h2,h3{font-weight:700;color:var(--mbv-ink)} h1{color:var(--mbv-red)}
.btn{background:var(--mbv-gold);color:var(--mbv-ink);font-weight:700;border:0;border-radius:999px;padding:.6em 1.4em}
.btn-primary{background:var(--mbv-red);color:var(--mbv-white)}
th{background:var(--mbv-red);color:var(--mbv-white)} tr:nth-child(even) td{background:var(--mbv-stone)}
"""
open(os.path.join(OUT, "mbv-tokens.css"), "w", encoding="utf8").write(css)
print("Đã tạo:", sorted(os.listdir(OUT)))
