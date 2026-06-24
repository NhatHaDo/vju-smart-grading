#!/usr/bin/env python
"""
calibrate_block.py
==================
Visual calibration tool — shift/resize bubble ROI circles for one block and
inspect alignment BEFORE touching threshold or scoring logic.

Three modes
-----------
MODE A — size+shift  (default)
  --dx / --dy shift the origin; --bubble-size overrides the square size.
  Grid via --grid-search iterates all combos of (dx, dy, size).

MODE B — center-only  (add --keep-size or --center-dx/dy)
  Only the origin shifts; bubbleDimensions stay at the template value.
  new_origin = old_origin + (center_dx, center_dy)
  Grid via --center-grid iterates combos of (center_dx, center_dy) only.

MODE C — gap calibration  (add --labels-gap-delta / --bubbles-gap-delta)
  Adjusts bubblesGap and/or labelsGap by an additive delta, keeping size.
  Can be combined freely with --center-dx/dy and --keep-size.
  new_labelsGap  = old_labelsGap  + labels_gap_delta
  new_bubblesGap = old_bubblesGap + bubbles_gap_delta
  Grid via --gap-grid iterates 4-D combos of
      (center_dx, center_dy, labels_gap_delta, bubbles_gap_delta).

Usage examples
--------------
# Mode A: shift + resize
python scripts/calibrate_block.py uploads/baidato_page-0001.jpg \\
    --block Block_CCCD --dx -6 --dy 8 --bubble-size 26

# Mode A: grid-search (dx, dy, size)
python scripts/calibrate_block.py uploads/baidato_page-0001.jpg \\
    --block Block_CCCD --grid-search

# Mode B: center-only, size unchanged
python scripts/calibrate_block.py uploads/baidato_page-0001.jpg \\
    --block Block_CCCD --center-dx -20 --center-dy 25 --keep-size

# Mode B: center-only grid-search
python scripts/calibrate_block.py uploads/baidato_page-0001.jpg \\
    --block Block_CCCD --center-grid --keep-size

# Mode C: adjust gap only (center stays, size stays)
python scripts/calibrate_block.py uploads/baidato_page-0001.jpg \\
    --block Block_CCCD --labels-gap-delta 2 --bubbles-gap-delta -2 --keep-size

# Mode C: full combined single pass
python scripts/calibrate_block.py uploads/baidato_page-0001.jpg \\
    --block Block_CCCD --center-dx -10 --center-dy 30 \\
    --labels-gap-delta 2 --bubbles-gap-delta -2 --keep-size

# Mode C: gap grid-search (4-D)
python scripts/calibrate_block.py uploads/baidato_page-0001.jpg \\
    --block Block_CCCD --gap-grid

# Save winner to template
python scripts/calibrate_block.py uploads/baidato_page-0001.jpg \\
    --block Block_CCCD --center-dx -10 --center-dy 30 \\
    --labels-gap-delta 2 --bubbles-gap-delta -2 --keep-size --save

Options
-------
--dx INT                  Horizontal pixel shift for origin  (Mode A, default 0)
--dy INT                  Vertical pixel shift   (Mode A, default 0)
--bubble-size INT         Override bubble size as square px  (Mode A only)
--bubbles-gap INT         Override bubblesGap (absolute)
--labels-gap INT          Override labelsGap  (absolute)
--center-dx INT           Horizontal pixel shift, size kept  (Mode B/C, default 0)
--center-dy INT           Vertical pixel shift,   size kept  (Mode B/C, default 0)
--labels-gap-delta FLOAT  Additive delta to labelsGap  (Mode C, default 0)
--bubbles-gap-delta FLOAT Additive delta to bubblesGap (Mode C, default 0)
--keep-size               Do NOT change bubbleDimensions  (Mode B/C)
--block NAME              Which fieldBlock to calibrate (required)
--out-dir PATH            Output directory  (default: outputs/debug_overlays/)
--template PATH           Template JSON      (default: templates/vju_main_template.json)
--margin INT              Extra pixels around block region in output image  (default 80)
--grid-search             Mode A grid: dx × dy × size
--center-grid             Mode B grid: center_dx × center_dy
--gap-grid                Mode C grid: center_dx × center_dy × labels_gap_delta × bubbles_gap_delta
--save                    Write non-grid winning params to template JSON
--no-crop                 Skip CropOnMarkers; use plain resize
"""

from __future__ import annotations

import argparse
import copy
import itertools
import json
import sys
from pathlib import Path

# ── Bootstrap sys.path ────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(BACKEND_DIR))

import cv2
import numpy as np

from app.core.omr.crop_on_markers import crop_on_markers
from app.core.omr.preprocessor import resize_to_template
from app.core.templates.template_loader import load_template, BubbleSpec, FieldBlockSpec

DEFAULT_TEMPLATE = BACKEND_DIR / "templates" / "vju_main_template.json"
DEFAULT_OUT_DIR  = BACKEND_DIR / "outputs" / "debug_overlays"

FONT       = cv2.FONT_HERSHEY_SIMPLEX
CLR_CIRCLE = (0,  0, 220)   # red (BGR)  — ROI circle
CLR_VALUE  = (0, 200,  20)  # green      — bubble value label
CLR_ORIGIN = (255, 80,  0)  # cyan       — block origin marker


# ─────────────────────────────────────────────────────────────────────────────
# Core helpers
# ─────────────────────────────────────────────────────────────────────────────

def _align_image(raw: np.ndarray, tpl, no_crop: bool) -> np.ndarray:
    """Return the aligned (2550×3301) grayscale image."""
    if no_crop:
        aligned = resize_to_template(raw, tpl.page_dimensions)
        print(f"  [align] simple resize → {aligned.shape[1]}×{aligned.shape[0]}")
        return aligned

    mc = None
    if tpl.marker_centers_in_template:
        mc = {k: tuple(v) for k, v in tpl.marker_centers_in_template.items()}

    result = crop_on_markers(raw, target_size=tuple(tpl.page_dimensions),
                              marker_centers_in_template=mc, debug=False)
    if result.success:
        print(f"  [align] CropOnMarkers ✓ → {result.image.shape[1]}×{result.image.shape[0]}")
        return result.image
    # Fallback
    print(f"  [align] CropOnMarkers failed ({result.reason}), falling back to resize")
    return resize_to_template(raw, tpl.page_dimensions)


def _make_block_bubbles(
    block: FieldBlockSpec,
    dx: int,
    dy: int,
    bubble_size: int | None,
    bubbles_gap: int | None,
    labels_gap: int | None,
    page_dimensions: list[int],
    labels_gap_delta: float = 0.0,
    bubbles_gap_delta: float = 0.0,
) -> list[BubbleSpec]:
    """
    Re-generate bubble coordinates for a block with overridden parameters.
    Returns a list of BubbleSpec, each shifted/resized as requested.

    labels_gap_delta / bubbles_gap_delta are additive to the template value
    (applied after any absolute override via labels_gap / bubbles_gap).
    """
    bw = bubble_size if bubble_size is not None else block.bubble_dimensions[0]
    bh = bubble_size if bubble_size is not None else block.bubble_dimensions[1]
    # Absolute override takes priority; delta is always relative to template
    bg = (bubbles_gap if bubbles_gap is not None else block.bubbles_gap) + bubbles_gap_delta
    lg = (labels_gap  if labels_gap  is not None else block.labels_gap)  + labels_gap_delta

    direction  = block.direction
    # _h = axis that bubbles advance along; _v = axis that labels advance along
    _h, _v = (1, 0) if direction == "vertical" else (0, 1)

    origin_x = block.origin[0] + dx
    origin_y = block.origin[1] + dy
    page_w, page_h = page_dimensions

    bubbles: list[BubbleSpec] = []
    lead = [float(origin_x), float(origin_y)]

    for label in block.field_labels:
        pt = lead.copy()
        for value in block.bubble_values:
            bx, by = int(round(pt[0])), int(round(pt[1]))
            # Clamp to page (don't crash, just warn)
            bx = max(0, min(bx, page_w - bw))
            by = max(0, min(by, page_h - bh))
            bubbles.append(BubbleSpec(
                field_label=label,
                bubble_value=value,
                x=bx, y=by, w=bw, h=bh,
                field_type=block.field_type,
                block_name=block.name,
            ))
            pt[_h] += bg
        lead[_v] += lg

    return bubbles


def _draw_block_on_image(
    aligned_bgr: np.ndarray,
    bubbles: list[BubbleSpec],
    show_values: bool = True,
) -> np.ndarray:
    """Draw bubble ROI circles and value labels onto a BGR copy of aligned_bgr."""
    vis = aligned_bgr.copy() if len(aligned_bgr.shape) == 3 else \
          cv2.cvtColor(aligned_bgr, cv2.COLOR_GRAY2BGR)

    for b in bubbles:
        cx = b.x + b.w // 2
        cy = b.y + b.h // 2
        r  = max(b.w, b.h) // 2

        cv2.circle(vis, (cx, cy), r, CLR_CIRCLE, 3)
        cv2.rectangle(vis, (b.x, b.y), (b.x + b.w, b.y + b.h), (180, 180, 0), 1)

        if show_values:
            # Small value label to the right of the circle
            cv2.putText(vis, b.bubble_value,
                        (cx + r + 3, cy + 5), FONT, 0.45, CLR_VALUE, 1)

    return vis


def _crop_block_region(
    vis: np.ndarray,
    bubbles: list[BubbleSpec],
    margin: int = 80,
) -> np.ndarray:
    """Crop the drawn image to the block's bounding box + margin."""
    if not bubbles:
        return vis
    x1 = max(0, min(b.x for b in bubbles) - margin)
    y1 = max(0, min(b.y for b in bubbles) - margin)
    x2 = min(vis.shape[1], max(b.x + b.w for b in bubbles) + margin)
    y2 = min(vis.shape[0], max(b.y + b.h for b in bubbles) + margin)
    return vis[y1:y2, x1:x2]


def _out_filename(block_name: str, dx: int, dy: int,
                  size: int | None, bg: int | None, lg: int | None) -> str:
    """Build a descriptive output filename for Mode A (size+shift)."""
    parts = [f"calibrate_{block_name}"]
    if dx != 0:
        parts.append(f"dx{dx:+d}")
    if dy != 0:
        parts.append(f"dy{dy:+d}")
    if size is not None:
        parts.append(f"size{size}")
    if bg is not None:
        parts.append(f"bg{bg}")
    if lg is not None:
        parts.append(f"lg{lg}")
    if len(parts) == 1:
        parts.append("default")
    return "_".join(parts) + ".jpg"


def _out_filename_center(block_name: str, cdx: int, cdy: int) -> str:
    """Build a descriptive output filename for Mode B (center-only)."""
    parts = [f"calibrate_{block_name}", "center"]
    if cdx != 0:
        parts.append(f"cdx{cdx:+d}")
    if cdy != 0:
        parts.append(f"cdy{cdy:+d}")
    if len(parts) == 2:
        parts.append("default")
    return "_".join(parts) + ".jpg"


def _out_filename_full(
    block_name: str,
    cdx: int,
    cdy: int,
    lgap_delta: float = 0.0,
    bgap_delta: float = 0.0,
) -> str:
    """
    Build a descriptive filename encoding center shift + gap deltas.
    Example: calibrate_Block_CCCD_cdx-10_cdy+35_lgap+2_bgap-2.jpg
    """
    parts = [f"calibrate_{block_name}"]
    if cdx != 0:
        parts.append(f"cdx{cdx:+d}")
    if cdy != 0:
        parts.append(f"cdy{cdy:+d}")
    if lgap_delta != 0.0:
        # Use :+g to drop trailing zeros (e.g. 2.0 → "+2", -1.5 → "-1.5")
        parts.append(f"lgap{lgap_delta:+g}")
    if bgap_delta != 0.0:
        parts.append(f"bgap{bgap_delta:+g}")
    if len(parts) == 1:
        parts.append("default")
    return "_".join(parts) + ".jpg"


def _run_single(
    aligned_bgr: np.ndarray,
    tpl,
    block: FieldBlockSpec,
    dx: int,
    dy: int,
    bubble_size: int | None,
    bubbles_gap: int | None,
    labels_gap: int | None,
    out_dir: Path,
    margin: int,
    labels_gap_delta: float = 0.0,
    bubbles_gap_delta: float = 0.0,
    out_filename: str | None = None,
) -> Path:
    """Run a single calibration pass, save image, return path.

    out_filename: explicit filename override; if None, auto-generated from params.
    labels_gap_delta / bubbles_gap_delta: additive deltas to template gap values.
    """
    bubbles = _make_block_bubbles(
        block, dx, dy, bubble_size, bubbles_gap, labels_gap,
        tpl.page_dimensions,
        labels_gap_delta=labels_gap_delta,
        bubbles_gap_delta=bubbles_gap_delta,
    )
    vis  = _draw_block_on_image(aligned_bgr, bubbles)
    crop = _crop_block_region(vis, bubbles, margin)

    fname    = out_filename or _out_filename(block.name, dx, dy, bubble_size, bubbles_gap, labels_gap)
    out_path = out_dir / fname

    # Scale down so the output fits reasonably on screen
    max_dim = 1400
    h, w = crop.shape[:2]
    scale = min(1.0, max_dim / max(h, w, 1))
    if scale < 1.0:
        crop = cv2.resize(crop, (int(w * scale), int(h * scale)))

    cv2.imwrite(str(out_path), crop, [cv2.IMWRITE_JPEG_QUALITY, 93])
    print(f"  → {out_path} ({crop.shape[1]}×{crop.shape[0]})")
    return out_path


def _save_to_template(
    template_path: Path,
    block_name: str,
    dx: int,
    dy: int,
    bubble_size: int | None,
    bubbles_gap: int | None,
    labels_gap: int | None,
    original_tpl,
    labels_gap_delta: float = 0.0,
    bubbles_gap_delta: float = 0.0,
):
    """Apply calibration params to the template JSON and write it back.

    Gap changes: absolute override (bubbles_gap / labels_gap) takes priority;
    otherwise the delta is added to the current template value.
    bubble_size=None → bubbleDimensions NOT written.
    """
    with open(template_path, "r", encoding="utf-8") as f:
        raw_json = json.load(f)

    block_raw = raw_json["fieldBlocks"].get(block_name)
    if block_raw is None:
        print(f"[ERROR] Block '{block_name}' not found in template JSON")
        return

    blk_spec = next((b for b in original_tpl.field_blocks if b.name == block_name), None)
    if blk_spec is None:
        print(f"[ERROR] Block '{block_name}' not found in loaded template")
        return

    orig_origin = list(blk_spec.origin)
    new_origin  = [orig_origin[0] + dx, orig_origin[1] + dy]
    block_raw["origin"] = new_origin

    changes = [f"    origin      : {orig_origin} → {new_origin}"]

    if bubble_size is not None:
        block_raw["bubbleDimensions"] = [bubble_size, bubble_size]
        changes.append(f"    bubbleDim   : [{bubble_size}, {bubble_size}]")

    # bubblesGap: absolute override OR additive delta
    if bubbles_gap is not None:
        block_raw["bubblesGap"] = bubbles_gap
        changes.append(f"    bubblesGap  : {bubbles_gap} (absolute)")
    elif bubbles_gap_delta != 0.0:
        new_bg = int(round(blk_spec.bubbles_gap + bubbles_gap_delta))
        block_raw["bubblesGap"] = new_bg
        changes.append(f"    bubblesGap  : {blk_spec.bubbles_gap} + ({bubbles_gap_delta:+g}) → {new_bg}")

    # labelsGap: absolute override OR additive delta
    if labels_gap is not None:
        block_raw["labelsGap"] = labels_gap
        changes.append(f"    labelsGap   : {labels_gap} (absolute)")
    elif labels_gap_delta != 0.0:
        new_lg = int(round(blk_spec.labels_gap + labels_gap_delta))
        block_raw["labelsGap"] = new_lg
        changes.append(f"    labelsGap   : {blk_spec.labels_gap} + ({labels_gap_delta:+g}) → {new_lg}")

    with open(template_path, "w", encoding="utf-8") as f:
        json.dump(raw_json, f, ensure_ascii=False, indent=2)

    print(f"\n[SAVED] {template_path}")
    print(f"  Block '{block_name}':")
    for line in changes:
        print(line)


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Visual calibration — adjust block ROI circles and inspect alignment.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Mode A — inspect current alignment
  python scripts/calibrate_block.py uploads/baidato_page-0001.jpg --block Block_CCCD

  # Mode A — shift + resize
  python scripts/calibrate_block.py uploads/baidato_page-0001.jpg \\
      --block Block_CCCD --dx -6 --dy 8 --bubble-size 26

  # Mode A — grid-search (dx, dy, size)
  python scripts/calibrate_block.py uploads/baidato_page-0001.jpg \\
      --block Block_CCCD --grid-search

  # Mode B — shift center only, keep bubble size
  python scripts/calibrate_block.py uploads/baidato_page-0001.jpg \\
      --block Block_CCCD --center-dx -20 --center-dy 25 --keep-size

  # Mode B — center-only grid-search
  python scripts/calibrate_block.py uploads/baidato_page-0001.jpg \\
      --block Block_CCCD --center-grid --keep-size

  # Save the winner back to the template
  python scripts/calibrate_block.py uploads/baidato_page-0001.jpg \\
      --block Block_CCCD --center-dx -20 --center-dy 25 --keep-size --save
        """,
    )
    p.add_argument("image",        help="Path to answer sheet image")
    p.add_argument("--block",      required=True, metavar="BLOCK_NAME",
                   help="Name of the fieldBlock to calibrate (e.g. Block_CCCD)")

    # ── Mode A: size + shift ─────────────────────────────────────────────
    grp_a = p.add_argument_group("Mode A — shift + size")
    grp_a.add_argument("--dx",         type=int, default=0,
                       help="Horizontal pixel shift for origin (default 0)")
    grp_a.add_argument("--dy",         type=int, default=0,
                       help="Vertical pixel shift for origin (default 0)")
    grp_a.add_argument("--bubble-size", type=int, default=None, metavar="PX",
                       help="Override bubble size as square [px, px] (default: template)")
    grp_a.add_argument("--bubbles-gap", type=int, default=None, metavar="PX",
                       help="Override bubblesGap (default: template)")
    grp_a.add_argument("--labels-gap",  type=int, default=None, metavar="PX",
                       help="Override labelsGap (default: template)")
    grp_a.add_argument("--grid-search", action="store_true",
                       help="Grid sweep: dx × dy × size")
    grp_a.add_argument("--grid-dx",    nargs="+", type=int, default=[-10, -6, -3, 0],
                       metavar="INT", help="dx values (default: -10 -6 -3 0)")
    grp_a.add_argument("--grid-dy",    nargs="+", type=int, default=[0, 4, 8, 12],
                       metavar="INT", help="dy values (default: 0 4 8 12)")
    grp_a.add_argument("--grid-size",  nargs="+", type=int, default=[24, 26, 28, 30],
                       metavar="INT", help="bubble-size values (default: 24 26 28 30)")

    # ── Mode B/C: center + gap ───────────────────────────────────────────
    grp_b = p.add_argument_group("Mode B/C — center shift + gap delta (--keep-size)")
    grp_b.add_argument("--keep-size",   action="store_true",
                       help="Keep bubbleDimensions unchanged (required for Mode B/C)")
    grp_b.add_argument("--center-dx",   type=int, default=0, metavar="PX",
                       help="Horizontal origin shift, size kept (default 0)")
    grp_b.add_argument("--center-dy",   type=int, default=0, metavar="PX",
                       help="Vertical origin shift, size kept (default 0)")
    grp_b.add_argument("--labels-gap-delta",  type=float, default=0.0, metavar="F",
                       help="Additive delta to labelsGap (default 0)")
    grp_b.add_argument("--bubbles-gap-delta", type=float, default=0.0, metavar="F",
                       help="Additive delta to bubblesGap (default 0)")
    grp_b.add_argument("--center-grid", action="store_true",
                       help="2-D grid: center_dx × center_dy (Mode B)")
    grp_b.add_argument("--gap-grid",    action="store_true",
                       help="4-D grid: center_dx × center_dy × labels_gap_delta × bubbles_gap_delta (Mode C)")
    grp_b.add_argument("--grid-center-dx", nargs="+", type=int,
                       default=[-15, -10, -5, 0], metavar="INT",
                       help="center_dx values (default: -15 -10 -5 0)")
    grp_b.add_argument("--grid-center-dy", nargs="+", type=int,
                       default=[25, 30, 35], metavar="INT",
                       help="center_dy values (default: 25 30 35)")
    grp_b.add_argument("--grid-labels-gap-delta", nargs="+", type=float,
                       default=[-4.0, -2.0, 0.0, 2.0, 4.0], metavar="F",
                       help="labels_gap_delta values (default: -4 -2 0 2 4)")
    grp_b.add_argument("--grid-bubbles-gap-delta", nargs="+", type=float,
                       default=[-4.0, -2.0, 0.0, 2.0, 4.0], metavar="F",
                       help="bubbles_gap_delta values (default: -4 -2 0 2 4)")

    # ── Common ───────────────────────────────────────────────────────────
    p.add_argument("--out-dir",  default=str(DEFAULT_OUT_DIR), metavar="PATH",
                   help=f"Output directory (default: {DEFAULT_OUT_DIR})")
    p.add_argument("--template", default=str(DEFAULT_TEMPLATE), metavar="PATH",
                   help=f"Template JSON (default: {DEFAULT_TEMPLATE})")
    p.add_argument("--margin",   type=int, default=80,
                   help="Pixel margin around block in output image (default 80)")
    p.add_argument("--save",     action="store_true",
                   help="Write single-pass winning params back to the template JSON")
    p.add_argument("--no-crop",  action="store_true",
                   help="Skip CropOnMarkers; use plain resize (for flatbed scans)")
    return p.parse_args()


def main() -> None:
    args = parse_args()

    # ── Resolve paths ─────────────────────────────────────────────────────
    image_path = Path(args.image)
    if not image_path.exists():
        image_path = BACKEND_DIR / args.image
    if not image_path.exists():
        print(f"[ERROR] Image not found: {args.image}", file=sys.stderr)
        sys.exit(1)

    template_path = Path(args.template)
    if not template_path.exists():
        print(f"[ERROR] Template not found: {template_path}", file=sys.stderr)
        sys.exit(1)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # ── Load template ──────────────────────────────────────────────────────
    print(f"[1/4] Loading template: {template_path}")
    tpl = load_template(template_path)
    block = next((b for b in tpl.field_blocks if b.name == args.block), None)
    if block is None:
        available = [b.name for b in tpl.field_blocks]
        print(f"[ERROR] Block '{args.block}' not found. Available: {', '.join(available)}",
              file=sys.stderr)
        sys.exit(1)

    bw_def = block.bubble_dimensions[0]
    bh_def = block.bubble_dimensions[1]
    print(f"      Block '{block.name}': origin={block.origin} "
          f"bubble={bw_def}×{bh_def} "
          f"bubblesGap={block.bubbles_gap} labelsGap={block.labels_gap} "
          f"type={block.field_type}")

    # Detect active mode:
    # Mode B/C = any center/gap/keep-size flag; Mode A = everything else
    use_bc_mode = (
        args.keep_size
        or args.center_grid
        or args.gap_grid
        or args.center_dx != 0
        or args.center_dy != 0
        or args.labels_gap_delta != 0.0
        or args.bubbles_gap_delta != 0.0
    )

    # ── Load + align image ─────────────────────────────────────────────────
    print(f"[2/4] Loading image: {image_path}")
    raw = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE)
    if raw is None:
        print(f"[ERROR] Cannot read image: {image_path}", file=sys.stderr)
        sys.exit(1)
    print(f"      Original: {raw.shape[1]}×{raw.shape[0]}")

    print(f"[3/4] Aligning image …")
    aligned_gray = _align_image(raw, tpl, args.no_crop)
    aligned_bgr  = cv2.cvtColor(aligned_gray, cv2.COLOR_GRAY2BGR)

    # ── Run calibration ────────────────────────────────────────────────────
    print(f"[4/4] Generating calibration image(s) → {out_dir}")

    def _verify_save(template_path: Path) -> None:
        try:
            load_template(template_path)
            print("[OK] Template re-loads cleanly after save.")
        except Exception as e:
            print(f"[WARN] Template re-load failed: {e}")

    # ════════════════════════════════════════════════════════════════════
    # MODE C — 4-D gap grid (--gap-grid)
    # Iterates center_dx × center_dy × labels_gap_delta × bubbles_gap_delta
    # ════════════════════════════════════════════════════════════════════
    if args.gap_grid:
        cdx_vals  = args.grid_center_dx
        cdy_vals  = args.grid_center_dy
        lgap_vals = args.grid_labels_gap_delta
        bgap_vals = args.grid_bubbles_gap_delta
        combos    = list(itertools.product(cdx_vals, cdy_vals, lgap_vals, bgap_vals))
        print(f"      Mode C gap-grid: {len(combos)} combos")
        print(f"        center_dx={cdx_vals}  center_dy={cdy_vals}")
        print(f"        labels_gap_delta={lgap_vals}  bubbles_gap_delta={bgap_vals}")
        print(f"        bubble_size={bw_def} (kept)  labelsGap={block.labels_gap}  bubblesGap={block.bubbles_gap}")

        saved = []
        for cdx, cdy, lgap_d, bgap_d in combos:
            fname = _out_filename_full(block.name, cdx, cdy, lgap_d, bgap_d)
            p = _run_single(
                aligned_bgr, tpl, block,
                dx=cdx, dy=cdy,
                bubble_size=None,
                bubbles_gap=None, labels_gap=None,
                out_dir=out_dir, margin=args.margin,
                labels_gap_delta=lgap_d,
                bubbles_gap_delta=bgap_d,
                out_filename=fname,
            )
            saved.append(p)

        print(f"\nDone — {len(saved)} images saved to {out_dir}")
        print("Compare 4 corners of each image. Pick best params, then run:")
        print("  python scripts/calibrate_block.py <img> --block <B> "
              "--center-dx X --center-dy Y --labels-gap-delta L --bubbles-gap-delta G "
              "--keep-size --save")

    # ════════════════════════════════════════════════════════════════════
    # MODE B — 2-D center grid (--center-grid)
    # ════════════════════════════════════════════════════════════════════
    elif args.center_grid:
        cdx_vals = args.grid_center_dx
        cdy_vals = args.grid_center_dy
        combos   = list(itertools.product(cdx_vals, cdy_vals))
        print(f"      Mode B center-grid: {len(combos)} combos "
              f"(center_dx={cdx_vals}, center_dy={cdy_vals}, size={bw_def} kept)")
        saved = []
        for cdx, cdy in combos:
            fname = _out_filename_full(block.name, cdx, cdy)
            p = _run_single(
                aligned_bgr, tpl, block,
                dx=cdx, dy=cdy,
                bubble_size=None,
                bubbles_gap=None, labels_gap=None,
                out_dir=out_dir, margin=args.margin,
                out_filename=fname,
            )
            saved.append(p)

        print(f"\nDone — {len(saved)} images saved to {out_dir}")
        print("Pick best (center_dx, center_dy), then add --save to commit.")

    # ════════════════════════════════════════════════════════════════════
    # MODE B/C single pass — combined center shift + gap deltas
    # ════════════════════════════════════════════════════════════════════
    elif use_bc_mode:
        cdx    = args.center_dx
        cdy    = args.center_dy
        lgap_d = args.labels_gap_delta
        bgap_d = args.bubbles_gap_delta

        print(f"      Mode B/C: center_dx={cdx} center_dy={cdy} "
              f"labels_gap_delta={lgap_d:+g} bubbles_gap_delta={bgap_d:+g} "
              f"bubble_size={bw_def} (kept)")

        fname    = _out_filename_full(block.name, cdx, cdy, lgap_d, bgap_d)
        out_path = _run_single(
            aligned_bgr, tpl, block,
            dx=cdx, dy=cdy,
            bubble_size=None,
            bubbles_gap=None, labels_gap=None,
            out_dir=out_dir, margin=args.margin,
            labels_gap_delta=lgap_d,
            bubbles_gap_delta=bgap_d,
            out_filename=fname,
        )
        print(f"\nDone — saved: {out_path}")

        if args.save:
            _save_to_template(
                template_path=template_path,
                block_name=args.block,
                dx=cdx, dy=cdy,
                bubble_size=None,        # never touch bubbleDimensions in B/C
                bubbles_gap=None,
                labels_gap=None,
                original_tpl=tpl,
                labels_gap_delta=lgap_d,
                bubbles_gap_delta=bgap_d,
            )
            _verify_save(template_path)
        else:
            tip_parts = [f"--center-dx {cdx}", f"--center-dy {cdy}"]
            if lgap_d != 0.0:
                tip_parts.append(f"--labels-gap-delta {lgap_d:+g}")
            if bgap_d != 0.0:
                tip_parts.append(f"--bubbles-gap-delta {bgap_d:+g}")
            tip_parts.append("--keep-size --save")
            print(f"\nTip: add --save (or re-run with: {' '.join(tip_parts)})")

    # ════════════════════════════════════════════════════════════════════
    # MODE A — shift + optional resize (default)
    # ════════════════════════════════════════════════════════════════════
    else:
        if args.grid_search:
            combos = list(itertools.product(args.grid_dx, args.grid_dy, args.grid_size))
            print(f"      Mode A grid: {len(combos)} combos "
                  f"(dx={args.grid_dx}, dy={args.grid_dy}, size={args.grid_size})")
            saved = []
            for dx, dy, sz in combos:
                p = _run_single(aligned_bgr, tpl, block,
                                dx=dx, dy=dy, bubble_size=sz,
                                bubbles_gap=None, labels_gap=None,
                                out_dir=out_dir, margin=args.margin)
                saved.append(p)

            print(f"\nDone — {len(saved)} images saved to {out_dir}")
            print("Open images side by side to find the best (dx, dy, size).")
            print("Re-run without --grid-search and add --save to write the winner.")

        else:
            dx    = args.dx
            dy    = args.dy
            bsize = args.bubble_size
            bgap  = args.bubbles_gap
            lgap  = args.labels_gap

            print(f"      Mode A: dx={dx} dy={dy} "
                  f"size={bsize if bsize is not None else f'{bw_def} (kept)'} "
                  f"bubblesGap={bgap if bgap is not None else '(kept)'} "
                  f"labelsGap={lgap if lgap is not None else '(kept)'}")

            out_path = _run_single(aligned_bgr, tpl, block,
                                   dx=dx, dy=dy, bubble_size=bsize,
                                   bubbles_gap=bgap, labels_gap=lgap,
                                   out_dir=out_dir, margin=args.margin)

            print(f"\nDone — saved: {out_path}")

            if args.save:
                _save_to_template(
                    template_path=template_path,
                    block_name=args.block,
                    dx=dx, dy=dy,
                    bubble_size=bsize,
                    bubbles_gap=bgap,
                    labels_gap=lgap,
                    original_tpl=tpl,
                )
                _verify_save(template_path)
            else:
                print(f"\nTip: add --save to write these params to the template.")


if __name__ == "__main__":
    main()
