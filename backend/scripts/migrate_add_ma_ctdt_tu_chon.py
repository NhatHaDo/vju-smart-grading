"""
migrate_add_ma_ctdt_tu_chon.py
================================
One-shot migration: add ma_ctdt + tu_chon columns to batch_results table,
then backfill existing rows from info_field_columns_json.

Safe to re-run — existing columns are skipped, already-backfilled rows untouched.

Run from the backend/ directory:
    python scripts/migrate_add_ma_ctdt_tu_chon.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Allow running from repo root or backend/
ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from sqlalchemy import text  # noqa: E402

from app.database import engine  # noqa: E402

# ── Alias lookup for ma_ctdt / tu_chon ────────────────────────────────────────

MA_CTDT_ALIASES = ['ma_ctdt', 'mactdt', 'maCTDT', 'MaCTDT', 'ctdt', 'program_code']
TU_CHON_ALIASES = ['tu_chon', 'tuchon', 'tuChon', 'TuChon', 'elective']


def _extract_from_ifc(blob: str | None, aliases: list[str]) -> str | None:
    """
    Parse info_field_columns_json and extract + concatenate digit values for
    the first matching alias key.

    info_field_columns_json shape (example):
        {
          "ma_ctdt": [
            {"columnIndex": 0, "value": "A", "status": "ok", "digits": ["A"]},
            ...
          ]
        }

    Returns None if blob is null, key not found, or all values are '_'.
    """
    if not blob:
        return None
    try:
        data: dict = json.loads(blob)
    except Exception:
        return None
    for key in aliases:
        cols = data.get(key)
        if cols and isinstance(cols, list):
            val = ''.join(str(c.get('value', '_')) for c in cols)
            cleaned = val.replace('_', '')
            if cleaned:
                return val  # return raw including '_' so UI can highlight blanks
    return None


# ── Step 1: add columns if missing ────────────────────────────────────────────

NEW_COLS = [('ma_ctdt', 'VARCHAR(50)'), ('tu_chon', 'VARCHAR(10)')]

print("Checking current batch_results columns ...")
with engine.connect() as conn:
    result = conn.execute(text("PRAGMA table_info(batch_results)"))
    existing = {row[1] for row in result}
    print("  existing:", sorted(existing))

    for col, typ in NEW_COLS:
        if col not in existing:
            conn.execute(text(f"ALTER TABLE batch_results ADD COLUMN {col} {typ}"))
            conn.commit()
            print(f"  + added column: {col}")
        else:
            print(f"  ✓ column already exists: {col}")

# ── Step 2: backfill from info_field_columns_json ─────────────────────────────

print("\nBackfilling ma_ctdt / tu_chon from info_field_columns_json ...")

with engine.connect() as conn:
    rows = conn.execute(
        text("SELECT id, ma_ctdt, tu_chon, info_field_columns_json FROM batch_results")
    ).fetchall()
    print(f"  total rows: {len(rows)}")

    updated = 0
    for row in rows:
        row_id, ma_ctdt_db, tu_chon_db, blob = row

        new_ma = _extract_from_ifc(blob, MA_CTDT_ALIASES) if ma_ctdt_db is None else None
        new_tu = _extract_from_ifc(blob, TU_CHON_ALIASES) if tu_chon_db is None else None

        if new_ma is not None or new_tu is not None:
            if new_ma is not None and new_tu is not None:
                conn.execute(
                    text("UPDATE batch_results SET ma_ctdt = :m, tu_chon = :t WHERE id = :id"),
                    {"m": new_ma, "t": new_tu, "id": row_id},
                )
            elif new_ma is not None:
                conn.execute(
                    text("UPDATE batch_results SET ma_ctdt = :m WHERE id = :id"),
                    {"m": new_ma, "id": row_id},
                )
            else:
                conn.execute(
                    text("UPDATE batch_results SET tu_chon = :t WHERE id = :id"),
                    {"t": new_tu, "id": row_id},
                )
            updated += 1

    if updated:
        conn.commit()
    print(f"  backfilled {updated} row(s)")

# ── Verify ────────────────────────────────────────────────────────────────────

print("\nPost-migration sample (first 5 rows):")
with engine.connect() as conn:
    result = conn.execute(
        text("SELECT id, cccd, sbd, ma_ctdt, tu_chon FROM batch_results LIMIT 5")
    )
    for r in result:
        print(f"  id={r[0]}  cccd={r[1]!r}  sbd={r[2]!r}  ma_ctdt={r[3]!r}  tu_chon={r[4]!r}")

print("\nDone.")
