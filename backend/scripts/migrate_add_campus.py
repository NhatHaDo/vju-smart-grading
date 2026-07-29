"""
migrate_add_campus.py
======================
One-shot migration: add `campus` column to the exams table (values: "MD" | "HL").

Safe to re-run — skips if the column already exists.

Run from the backend/ directory:
    python scripts/migrate_add_campus.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# Allow running from repo root or backend/
ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from sqlalchemy import text  # noqa: E402

from app.database import engine  # noqa: E402

print("Checking current exams columns ...")
with engine.connect() as conn:
    result = conn.execute(text("PRAGMA table_info(exams)"))
    existing = {row[1] for row in result}
    print("  existing:", sorted(existing))

    if "campus" not in existing:
        conn.execute(text("ALTER TABLE exams ADD COLUMN campus VARCHAR(20)"))
        conn.commit()
        print("  + added column: campus")
    else:
        print("  ✓ column already exists: campus")

print("\nDone.")
