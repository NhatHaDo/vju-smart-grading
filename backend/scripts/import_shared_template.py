"""
import_shared_template.py
==========================
One-shot: install the "Mẫu 40 câu TN + Đúng/Sai" custom template (originally
drawn locally, id=8 on the local dev DB) onto THIS environment's database +
data folder, and mark it `is_default=True` (shared — readable by any
account, see _get_readable_or_404 in app/api/v1/routes/custom_forms.py).

This avoids re-drawing the template by hand in "Tạo Template Tọa Độ" on
every environment — it just copies the already-compiled JSON files from
backend/data/shared_templates/ (committed to git) into
backend/data/custom_forms/ (gitignored, per-environment) and upserts the
matching DB row.

Safe to re-run: if a template with the same NAME already exists, it
updates that row in place instead of creating a duplicate.

Run from the backend/ directory:
    python scripts/import_shared_template.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from app.database import SessionLocal   # noqa: E402
from app.models.template import Template  # noqa: E402

TEMPLATE_NAME = "Mẫu 40 câu TN + Đúng/Sai"

SRC_DIR    = ROOT / "data" / "shared_templates"
SRC_TPL    = SRC_DIR / "sheet_40tn_dungsai.template.json"
SRC_AREAS  = SRC_DIR / "sheet_40tn_dungsai.areas.json"

DEST_DIR   = ROOT / "data" / "custom_forms"
DEST_TPL   = DEST_DIR / "shared_40tn_dungsai.template.json"
DEST_AREAS = DEST_DIR / "shared_40tn_dungsai.areas.json"


def main() -> None:
    if not SRC_TPL.exists() or not SRC_AREAS.exists():
        print(f"✗ Không tìm thấy file nguồn trong {SRC_DIR} — bạn đã git pull bản mới nhất chưa?")
        sys.exit(1)

    DEST_DIR.mkdir(parents=True, exist_ok=True)
    DEST_TPL.write_text(SRC_TPL.read_text(encoding="utf-8"), encoding="utf-8")
    DEST_AREAS.write_text(SRC_AREAS.read_text(encoding="utf-8"), encoding="utf-8")
    print(f"+ Đã copy file compiled vào {DEST_TPL.name} / {DEST_AREAS.name}")

    compiled = json.loads(DEST_TPL.read_text(encoding="utf-8"))
    page_w, page_h = (compiled.get("pageDimensions") or [1000, 1414])[:2]

    db = SessionLocal()
    try:
        tpl = db.query(Template).filter(Template.name == TEMPLATE_NAME, Template.type == "custom").first()

        if tpl is None:
            tpl = Template(
                name=TEMPLATE_NAME,
                type="custom",
                version="1.0",
                file_path=str(DEST_TPL),
                areas_path=str(DEST_AREAS),
                page_width=page_w,
                page_height=page_h,
                owner_user_id=None,   # shared — not tied to one account
                is_default=True,
            )
            db.add(tpl)
            db.commit()
            db.refresh(tpl)
            print(f"+ Đã tạo template mới: id={tpl.id}")
        else:
            tpl.file_path      = str(DEST_TPL)
            tpl.areas_path     = str(DEST_AREAS)
            tpl.page_width     = page_w
            tpl.page_height    = page_h
            tpl.is_default     = True
            db.commit()
            print(f"+ Đã cập nhật template có sẵn: id={tpl.id}")

        print(f"\n=> Dùng ID này trong PINNED_TEMPLATES (SheetReviewPage.tsx): {tpl.id}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
