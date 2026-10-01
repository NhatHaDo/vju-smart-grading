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

Since 2026-09-29 the server installs this template by itself on startup when
it's missing (app/services/shared_templates.py) and the frontend looks up its
id via GET /custom-forms/pinned — this script is now only needed to refresh
the files of an existing row after the committed JSON changed.

Run from the backend/ directory:
    python scripts/import_shared_template.py
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.database import SessionLocal, init_db   # noqa: E402
from app.services.shared_templates import install_mau40   # noqa: E402


def main() -> None:
    init_db()   # make sure tables exist (fresh DB)
    db = SessionLocal()
    try:
        try:
            tpl, created = install_mau40(db, update_existing=True)
        except FileNotFoundError as exc:
            print(f"✗ {exc} — bạn đã git pull bản mới nhất chưa?")
            sys.exit(1)
        print(f"+ Đã {'tạo' if created else 'cập nhật'} template \"{tpl.name}\": id={tpl.id}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
