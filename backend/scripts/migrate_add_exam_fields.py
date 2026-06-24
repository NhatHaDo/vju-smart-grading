"""
One-shot migration: add Phase 2 exam fields to the exams table (SQLite).
Run from backend directory:
    python scripts/migrate_add_exam_fields.py

This is safe to re-run — existing columns are skipped.
"""
import sys
from pathlib import Path

# Allow running from repo root or backend/
ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from app.database import _migrate_exam_columns, engine  # noqa: E402
from sqlalchemy import text  # noqa: E402

print("Checking current columns...")
with engine.connect() as conn:
    result = conn.execute(text("PRAGMA table_info(exams)"))
    cols = [row[1] for row in result]
    print("  current:", cols)

print("Running migration...")
_migrate_exam_columns()

print("After migration:")
with engine.connect() as conn:
    result = conn.execute(text("PRAGMA table_info(exams)"))
    cols = [row[1] for row in result]
    print("  columns:", cols)

print("Done.")
