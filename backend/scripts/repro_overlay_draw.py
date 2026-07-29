"""
repro_overlay_draw.py
======================
(Named to avoid the backend/scripts/debug_*.py gitignore pattern — this one
needs to actually be committed and run on the server, not stay local.)

Standalone reproduction: run OMREngine.run_full_debug() directly (no web
server, no uvicorn, no logging-config ambiguity) against a template + an
already-uploaded debug image, and print exactly what happens — including
the full traceback if overlay drawing raises.

This exists because in production, three overlay-drawing steps inside
run_full_debug() (overlay_all / overlay_marked_only / overlay_warnings)
were producing neither their output file NOR any log/print output, even
after adding explicit print() calls to their except blocks — meaning
either they're not raising a normal Python exception, or something about
running under uvicorn is swallowing stdout for that code path. Running the
exact same call directly in a foreground script sidesteps all of that.

Usage (run from the backend/ directory):
    python scripts/repro_overlay_draw.py <template_id> <image_path>

Example (using the values from the actual failing production run):
    python scripts/repro_overlay_draw.py 2 uploads/debug/85ae7ccd8182438b85b9f62c33aa7a72.jpg
"""

from __future__ import annotations

import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

if len(sys.argv) != 3:
    print("Usage: python scripts/debug_overlay_repro.py <template_id> <image_path>")
    sys.exit(1)

template_id = int(sys.argv[1])
image_path  = sys.argv[2]

from app.database import SessionLocal            # noqa: E402
from app.repositories.template_repository import TemplateRepository  # noqa: E402
from app.core.templates.template_loader import load_template          # noqa: E402
from app.core.omr.engine import OMREngine                              # noqa: E402

db = SessionLocal()
try:
    repo = TemplateRepository(db)
    tpl_record = repo.get_by_id(template_id)
    if tpl_record is None:
        print(f"✗ Template id={template_id} not found in DB")
        sys.exit(1)
    print(f"Template: id={tpl_record.id} name={tpl_record.name!r} file_path={tpl_record.file_path}")

    template = load_template(tpl_record.file_path)
    print(f"Loaded template OK — {len(template.field_blocks)} field blocks")

    if not Path(image_path).exists():
        print(f"✗ Image not found: {image_path}")
        sys.exit(1)

    out_dir = ROOT / "outputs" / "debug_overlays_repro"
    out_dir.mkdir(parents=True, exist_ok=True)

    engine = OMREngine(
        template=template,
        enable_crop=True,
        debug_overlay_dir=out_dir,
        mean_mode="circle_mask",
    )

    print("\nCalling run_full_debug()...\n" + "=" * 60)
    try:
        omr_result, vis = engine.run_full_debug(
            image_path,
            output_dir=out_dir,
            prefix="repro",
            answer_key=None,
            block_filter=None,
            image_source="auto",
        )
        print("=" * 60)
        print("run_full_debug() returned without raising.\n")
        print("DebugVisualPaths result:")
        for f in ("aligned_image_path", "aligned_candidate_path", "overlay_all_path",
                   "overlay_marked_only_path", "overlay_warnings_path",
                   "markers_debug_path", "means_json_path"):
            print(f"  {f}: {getattr(vis, f, None)}")
    except Exception:
        print("=" * 60)
        print("run_full_debug() RAISED — full traceback:\n")
        traceback.print_exc()
finally:
    db.close()
