"""
overlay_cleanup.py
===================
Shared helper for deleting the on-disk debug overlay files
(outputs/debug_overlays/*.jpg) that belong to a BatchResult row, so they
stop piling up forever once that result is deleted.

Why this exists (2026-08-03)
----------------------------
POST /omr/debug-grade writes a fresh set of debug images per grading
attempt under outputs/debug_overlays/{run_id}_*.jpg (run_id = a random
uuid4().hex — see omr.py's `unique_name`), and the paths are saved into
BatchResult.debug_paths_json so the frontend can re-fetch them whenever a
saved result is reopened. Deleting a result from the Results page used to
only remove the DB row — the files stayed on disk forever, which is how
scoring.cunghoc.net's disk quota filled up (see
scripts/cleanup_orphan_overlays.py for the one-off historical cleanup of
files orphaned by *already*-deleted rows before this fix existed).

Each grading attempt gets a fresh uuid4().hex run id every time (even
re-grading the same physical sheet produces a new one), so a run id is
never shared between two different BatchResult rows — safe to delete all
files sharing that run's prefix the moment its row is deleted.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from app.config import get_settings

_RUN_ID_RE = re.compile(r"^([0-9a-f]{32})")


def _extract_run_ids(value, run_ids: set[str]) -> None:
    """Recursively pull uuid4-hex run ids out of every string in `value`,
    regardless of whether debug_paths_json is a flat dict, nested, or a
    list — the frontend controls the exact shape (schema types it as
    `Any`), so we don't assume a fixed set of keys."""
    if isinstance(value, str):
        m = _RUN_ID_RE.search(Path(value).name)
        if m:
            run_ids.add(m.group(1))
    elif isinstance(value, dict):
        for v in value.values():
            _extract_run_ids(v, run_ids)
    elif isinstance(value, list):
        for v in value:
            _extract_run_ids(v, run_ids)


def delete_overlay_files_for(debug_paths_json: str | None) -> int:
    """
    Given one BatchResult row's debug_paths_json blob, delete every debug
    overlay file on disk belonging to the same grading run(s) it
    references. Returns the number of files actually deleted.

    Safe no-op if blank/None/unparseable/no matching files — never raises,
    since this runs as a best-effort cleanup step after the DB row is
    already gone; a stray leftover file is a minor disk-space nit, not
    worth failing the delete request over.
    """
    if not debug_paths_json:
        return 0
    try:
        parsed = json.loads(debug_paths_json)
    except (TypeError, ValueError):
        return 0

    run_ids: set[str] = set()
    _extract_run_ids(parsed, run_ids)
    if not run_ids:
        return 0

    overlay_dir = Path(get_settings().omr_output_dir) / "debug_overlays"
    if not overlay_dir.is_dir():
        return 0

    deleted = 0
    for f in overlay_dir.iterdir():
        if not f.is_file():
            continue
        m = _RUN_ID_RE.search(f.name)
        if m and m.group(1) in run_ids:
            try:
                f.unlink()
                deleted += 1
            except OSError:
                pass
    return deleted


def delete_overlay_files_for_many(debug_paths_jsons: list[str | None]) -> int:
    """Batch version of delete_overlay_files_for(), for bulk-delete routes."""
    total = 0
    for blob in debug_paths_jsons:
        total += delete_overlay_files_for(blob)
    return total
