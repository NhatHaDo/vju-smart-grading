"""
mark_template_shared.py
========================
One-shot: flag a custom template `is_default=True` so it becomes readable
by *every* logged-in account, not just the account that created it.

This is what makes a "pinned" template (see PINNED_TEMPLATES in
frontend/src/pages/SheetReviewPage.tsx) usable from any account — the
GET /custom-forms/{id} endpoint allows read access to owned templates OR
templates flagged is_default (see _get_readable_or_404 in
app/api/v1/routes/custom_forms.py).

Usage (run from the backend/ directory):
    python scripts/mark_template_shared.py <template_id>

Example:
    python scripts/mark_template_shared.py 3
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from app.database import SessionLocal  # noqa: E402
from app.models.template import Template  # noqa: E402

if len(sys.argv) != 2 or not sys.argv[1].isdigit():
    print("Usage: python scripts/mark_template_shared.py <template_id>")
    sys.exit(1)

template_id = int(sys.argv[1])

db = SessionLocal()
try:
    tpl = db.get(Template, template_id)
    if tpl is None:
        print(f"✗ Không tìm thấy template id={template_id}")
        sys.exit(1)

    print(f"Template found: id={tpl.id}  name={tpl.name!r}  type={tpl.type}  owner_user_id={tpl.owner_user_id}  is_default(before)={tpl.is_default}")

    if tpl.type != "custom":
        print(f"✗ Template này type={tpl.type!r}, không phải 'custom' — script này chỉ dành cho custom template.")
        sys.exit(1)

    if tpl.is_default:
        print("✓ Đã được đánh dấu shared từ trước, không cần làm gì thêm.")
    else:
        tpl.is_default = True
        db.commit()
        print("+ Đã đánh dấu is_default=True — mọi tài khoản đăng nhập giờ đều đọc được template này.")
finally:
    db.close()
