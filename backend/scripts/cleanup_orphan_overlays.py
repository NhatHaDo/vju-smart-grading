"""
cleanup_orphan_overlays.py
===========================
Frees disk space in `outputs/debug_overlays/` by deleting files that no
saved result references anymore.

Why this exists (2026-08-03)
----------------------------
Every call to POST /omr/debug-grade writes a fresh set of debug images
(aligned/overlay/markers, one file per output type) under
`outputs/debug_overlays/{run_id}_*.jpg`, where `run_id` is a random
uuid4().hex generated per upload — see omr.py's `unique_name`. These
files are served statically at /outputs/... and re-fetched whenever a
saved result is reopened (path is stored in BatchResult.debug_paths_json),
so they can't just be blanket-deleted — but nothing in the codebase ever
cleans them up, including when a result row is deleted from the DB
(results.py's delete_result()/delete_all_results() only touch the DB row).

Over time this means the directory accumulates one full set of debug
images for EVERY grading attempt ever made — including abandoned/never-
saved debug-grade calls and results that were later deleted from the
Results page — forever. On scoring.cunghoc.net this alone grew to 1.2GB
out of a 2GB disk quota and started causing `sqlite3.OperationalError:
disk I/O error` (disk essentially full).

What this script does
----------------------
1. Reads every non-null `debug_paths_json` from the `batch_results` table.
2. Extracts the uuid4-hex "run id" prefix from each referenced filename
   (all sibling debug files for one grading run share the same 32-hex-char
   prefix, e.g. `3f9a2b.../3f9a2b..._overlay_all.jpg` and
   `3f9a2b..._aligned_by_markers.jpg` both belong to run `3f9a2b...`).
3. Walks `outputs/debug_overlays/` and deletes any file whose run-id
   prefix is NOT referenced by any existing DB row — i.e. true orphans
   that no saved result can possibly still be displaying.

This is safe by construction: it only deletes files nothing in the
database points to, so no currently-viewable result's "Ảnh detect" /
"Ảnh đã căn chỉnh" tab is affected.

Usage
-----
    cd backend && source .venv/bin/activate   # or however the venv is activated
    python scripts/cleanup_orphan_overlays.py            # dry run — lists what WOULD be deleted
    python scripts/cleanup_orphan_overlays.py --delete   # actually deletes orphans
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # so `import app.*` works

from app.config import get_settings
from app.database import SessionLocal
from app.models.batch_result import BatchResult

RUN_ID_RE = re.compile(r"^([0-9a-f]{32})")


def _extract_run_ids_from_value(value, run_ids: set[str]) -> None:
    """Recursively walk any JSON-decoded value, pulling uuid4-hex run ids
    out of every string found (regardless of the dict/list shape used)."""
    if isinstance(value, str):
        m = RUN_ID_RE.search(Path(value).name)
        if m:
            run_ids.add(m.group(1))
    elif isinstance(value, dict):
        for v in value.values():
            _extract_run_ids_from_value(v, run_ids)
    elif isinstance(value, list):
        for v in value:
            _extract_run_ids_from_value(v, run_ids)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--delete", action="store_true", help="Actually delete orphan files (default: dry run)")
    args = parser.parse_args()

    settings = get_settings()
    overlay_dir = Path(settings.omr_output_dir) / "debug_overlays"
    if not overlay_dir.is_dir():
        print(f"No such directory: {overlay_dir}")
        return

    print(f"Scanning DB for referenced run ids...")
    referenced_run_ids: set[str] = set()
    db = SessionLocal()
    try:
        rows = (
            db.query(BatchResult.debug_paths_json)
            .filter(BatchResult.debug_paths_json.isnot(None))
            .all()
        )
        for (raw,) in rows:
            try:
                parsed = json.loads(raw)
            except (TypeError, ValueError):
                continue
            _extract_run_ids_from_value(parsed, referenced_run_ids)
    finally:
        db.close()

    print(f"  {len(referenced_run_ids)} distinct grading runs still referenced by saved results.")

    all_files = sorted(overlay_dir.iterdir())
    orphans: list[Path] = []
    kept = 0
    total_orphan_bytes = 0
    for f in all_files:
        if not f.is_file():
            continue
        m = RUN_ID_RE.search(f.name)
        run_id = m.group(1) if m else None
        if run_id is not None and run_id in referenced_run_ids:
            kept += 1
            continue
        orphans.append(f)
        total_orphan_bytes += f.stat().st_size

    print(f"  {len(all_files)} files total in {overlay_dir}")
    print(f"  {kept} files kept (referenced by a saved result)")
    print(f"  {len(orphans)} orphan files found — {total_orphan_bytes / 1024 / 1024:.1f} MB")

    if not args.delete:
        print("\nDry run only — nothing deleted. Re-run with --delete to actually remove these files.")
        return

    removed = 0
    freed = 0
    for f in orphans:
        try:
            size = f.stat().st_size
            f.unlink()
            removed += 1
            freed += size
        except OSError as exc:
            print(f"  ! failed to remove {f}: {exc}")

    print(f"\nDeleted {removed} orphan files, freed {freed / 1024 / 1024:.1f} MB.")


if __name__ == "__main__":
    main()
