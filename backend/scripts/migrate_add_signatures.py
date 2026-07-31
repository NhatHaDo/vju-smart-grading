"""
migrate_add_signatures.py
==========================
One-shot migration: add signatures_json column to batch_results table.

2026-07-31: "file export kết quả cần hiện cả Giám thị coi thi đã kí tên hay
chưa" — the OMR signature ink-detection result (SignatureCheck[]) was never
persisted, only returned live from /omr/debug-grade. Historical rows have no
signature data to backfill (it was never computed for them), so this just
adds the column — new rows saved after this migration + the matching backend
deploy will start carrying it.

Safe to re-run — existing column is skipped.

Run from the backend/ directory:
    python scripts/migrate_add_signatures.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# Allow running from repo root or backend/
ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from sqlalchemy import text  # noqa: E402

from app.database import engine  # noqa: E402

print("Checking current batch_results columns ...")
with engine.connect() as conn:
    result = conn.execute(text("PRAGMA table_info(batch_results)"))
    existing = {row[1] for row in result}
    print("  existing:", sorted(existing))

    if "signatures_json" not in existing:
        conn.execute(text("ALTER TABLE batch_results ADD COLUMN signatures_json TEXT"))
        conn.commit()
        print("  + added column: signatures_json")
    else:
        print("  ✓ column already exists: signatures_json")

print("\nDone.")
