#!/usr/bin/env python
"""
pick_block_points.py
====================
Manual calibration tool — click 4 corner bubble centers on the ALIGNED image
to derive accurate origin, labelsGap, bubblesGap, and bubbleDimensions.

Pipeline (default):
  raw image
    → detect 4 corner markers  (CropOnMarkers)
    → perspective warp          → pageDimensions
    → aligned grayscale image
    → open calibration window

Usage
-----
  python scripts/pick_block_points.py uploads/baidato_page-0001.jpg --block Block_CCCD
  python scripts/pick_block_points.py aligned.jpg --block Block_CCCD --already-aligned --save
  python scripts/pick_block_points.py raw.jpg --block Block_CCCD --save-aligned-debug --save

Flags
-----
  --already-aligned   skip all preprocessing; pick directly on input image
  --no-crop           skip CropOnMarkers; use plain resize instead
  --save-aligned-debug  save the image being picked on to
                          outputs/debug_overlays/pick_<block>_aligned_input.jpg

Click order
-----------
  1. top-left  bubble center
  2. top-right bubble center
  3. bottom-left  bubble center
  4. bottom-right bubble center

Keys
----
  r   — reset clicks
  s   — compute + save (same as --save flag)
  q   — quit without saving
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import NamedTuple

# ── Bootstrap sys.path ────────────────────────────────────────────────────────
SCRIPT_DIR  = Path(__file__).resolve().parent
BACKEND_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(BACKEND_DIR))

import cv2
import numpy as np

from app.core.omr.crop_on_markers import crop_on_markers
from app.core.omr.preprocessor    import resize_to_template
from app.core.templates.template_loader import load_template, FieldBlockSpec

DEFAULT_TEMPLATE = BACKEND_DIR / "templates" / "vju_main_template.json"
DEFAULT_OUT_DIR  = BACKEND_DIR / "outputs" / "debug_overlays"

FONT = cv2.FONT_HERSHEY_SIMPLEX

CLR_CLICK   = (50,  200,  50)
CLR_CIRCLE  = (0,   80,  220)
CLR_LABEL   = (220, 180,   0)
CLR_HINT    = (255, 255, 255)
CLR_DONE    = (50,  220, 120)

CLICK_LABELS = [
    "1: top-left",
    "2: top-right",
    "3: bottom-left",
    "4: bottom-right",
]

MAX_WIN_DIM  = 1300
VIEW_MARGIN  = 200


# ─────────────────────────────────────────────────────────────────────────────
# Data
# ─────────────────────────────────────────────────────────────────────────────

class Point(NamedTuple):
    x: float
    y: float


class BlockDims(NamedTuple):
    rows: int
    cols: int


class CalibResult(NamedTuple):
    origin:       list[int]
    bubble_dim:   list[int]
    labels_gap:   float
    bubbles_gap:  float
    tl: Point
    tr: Point
    bl: Point
    br: Point


# ─────────────────────────────────────────────────────────────────────────────
# Alignment pipeline
# ─────────────────────────────────────────────────────────────────────────────

def _align_image(
    raw: np.ndarray,
    tpl,
    *,
    already_aligned: bool = False,
    no_crop: bool = False,
) -> np.ndarray:
    """
    Return aligned grayscale image at template pageDimensions.

    Modes:
      already_aligned=True  → return input as-is (after size check)
      no_crop=True          → plain resize only
      default               → CropOnMarkers → warp → resize fallback
    """
    pw, ph = tpl.page_dimensions
    h0, w0 = raw.shape[:2]
    print(f"  [align] original image size : {w0}×{h0}")
    print(f"  [align] template pageDimensions : {pw}×{ph}")

    gray = raw if len(raw.shape) == 2 else cv2.cvtColor(raw, cv2.COLOR_BGR2GRAY)

    # ── Mode 1: already aligned ────────────────────────────────────────────
    if already_aligned:
        print("  [align] mode: already-aligned — skipping preprocessing")
        if w0 != pw or h0 != ph:
            print(f"  [WARN]  image size {w0}×{h0} ≠ pageDimensions {pw}×{ph}")
            print(f"  [WARN]  coordinate picks may be off — consider --no-crop for resize")
        else:
            print(f"  [align] size matches pageDimensions ✓")
        return gray

    # ── Mode 2: simple resize ──────────────────────────────────────────────
    if no_crop:
        print("  [align] mode: no-crop (plain resize)")
        aligned = resize_to_template(gray, tpl.page_dimensions)
        ah, aw = aligned.shape[:2]
        print(f"  [align] resized → {aw}×{ah}")
        _check_size(aw, ah, pw, ph)
        return aligned

    # ── Mode 3: CropOnMarkers (default) ───────────────────────────────────
    print("  [align] mode: CropOnMarkers (detect 4 markers → warp)")

    mc = None
    if tpl.marker_centers_in_template:
        mc = {k: tuple(v) for k, v in tpl.marker_centers_in_template.items()}
        print(f"  [align] template marker target positions:")
        for key, val in mc.items():
            print(f"            {key}: {val}")

    result = crop_on_markers(
        gray,
        target_size=tuple(tpl.page_dimensions),
        marker_centers_in_template=mc,
        debug=False,
    )

    if result.success:
        # Log detected marker centers (marker_pts is 4×2 float32, order TL TR BR BL)
        if result.marker_pts is not None:
            pts = result.marker_pts
            names = ["TL", "TR", "BR", "BL"]
            print(f"  [align] detected marker centers:")
            for name, pt in zip(names, pts):
                print(f"            {name}: ({pt[0]:.1f}, {pt[1]:.1f})")
        ah, aw = result.image.shape[:2]
        print(f"  [align] CropOnMarkers ✓ → {aw}×{ah}")
        _check_size(aw, ah, pw, ph)
        return result.image

    # ── Fallback: resize ──────────────────────────────────────────────────
    print(f"  [align] CropOnMarkers failed: {result.reason}")
    print(f"  [align] falling back to plain resize")
    aligned = resize_to_template(gray, tpl.page_dimensions)
    ah, aw = aligned.shape[:2]
    print(f"  [align] resized → {aw}×{ah}")
    _check_size(aw, ah, pw, ph)
    return aligned


def _check_size(aw: int, ah: int, pw: int, ph: int) -> None:
    """Warn (or error) if aligned image size differs from pageDimensions."""
    if aw != pw or ah != ph:
        print(f"  [ERROR] aligned size {aw}×{ah} ≠ pageDimensions {pw}×{ph}")
        print(f"          Coordinate picks will be incorrect.")
        print(f"          Use --already-aligned if the image is already at pageDimensions.")
        sys.exit(1)
    else:
        print(f"  [align] size matches pageDimensions {pw}×{ph} ✓")


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _block_dims(block: FieldBlockSpec) -> BlockDims:
    n_values = len(block.bubble_values)
    n_labels = len(block.field_labels)
    if block.direction == "vertical":
        return BlockDims(rows=n_values, cols=n_labels)
    else:
        return BlockDims(rows=n_labels, cols=n_values)


def _block_roi(block: FieldBlockSpec, tpl) -> tuple[int, int, int, int]:
    if not block.bubbles:
        ox, oy = block.origin
        return ox, oy, ox + 200, oy + 200
    xs  = [b.x         for b in block.bubbles]
    ys  = [b.y         for b in block.bubbles]
    x2s = [b.x + b.w   for b in block.bubbles]
    y2s = [b.y + b.h   for b in block.bubbles]
    return min(xs), min(ys), max(x2s), max(y2s)


def _compute_params(
    tl: Point, tr: Point, bl: Point, br: Point,
    dims: BlockDims,
    bubble_dim: list[int],
    direction: str,
) -> CalibResult:
    rows, cols = dims.rows, dims.cols
    w, h = bubble_dim

    x_span_top    = tr.x - tl.x
    x_span_bottom = br.x - bl.x
    y_span_left   = bl.y - tl.y
    y_span_right  = br.y - tr.y

    if direction == "vertical":
        bubbles_gap = ((y_span_left  / (rows - 1)) +
                       (y_span_right / (rows - 1))) / 2.0 if rows > 1 else float(h)
        labels_gap  = ((x_span_top    / (cols - 1)) +
                       (x_span_bottom / (cols - 1))) / 2.0 if cols > 1 else float(w)
    else:
        bubbles_gap = ((x_span_top    / (cols - 1)) +
                       (x_span_bottom / (cols - 1))) / 2.0 if cols > 1 else float(w)
        labels_gap  = ((y_span_left  / (rows - 1)) +
                       (y_span_right / (rows - 1))) / 2.0  if rows > 1 else float(h)

    origin_x = int(round(tl.x - w / 2.0))
    origin_y = int(round(tl.y - h / 2.0))

    return CalibResult(
        origin=[origin_x, origin_y],
        bubble_dim=list(bubble_dim),
        labels_gap=labels_gap,
        bubbles_gap=bubbles_gap,
        tl=tl, tr=tr, bl=bl, br=br,
    )


def _generate_preview_bubbles(
    result: CalibResult, dims: BlockDims, block: FieldBlockSpec,
) -> list[tuple[int, int, int, str]]:
    rows, cols = dims.rows, dims.cols
    w, h = result.bubble_dim
    r = max(w, h) // 2
    ox, oy    = result.origin
    direction = block.direction
    cells: list[tuple[int, int, int, str]] = []

    if direction == "vertical":
        x_step = result.labels_gap
        y_step = result.bubbles_gap
        for ci in range(cols):
            for ri in range(rows):
                cx = int(round(ox + w / 2.0 + ci * x_step))
                cy = int(round(oy + h / 2.0 + ri * y_step))
                cells.append((cx, cy, r, f"c{ci}r{ri}"))
    else:
        x_step = result.bubbles_gap
        y_step = result.labels_gap
        for ri in range(rows):
            for ci in range(cols):
                cx = int(round(ox + w / 2.0 + ci * x_step))
                cy = int(round(oy + h / 2.0 + ri * y_step))
                cells.append((cx, cy, r, f"r{ri}c{ci}"))

    return cells


# ─────────────────────────────────────────────────────────────────────────────
# View
# ─────────────────────────────────────────────────────────────────────────────

class ZoomView:
    def __init__(self, full_bgr: np.ndarray, roi: tuple[int, int, int, int]):
        fh, fw = full_bgr.shape[:2]
        x1, y1, x2, y2 = roi
        x1 = max(0, x1 - VIEW_MARGIN)
        y1 = max(0, y1 - VIEW_MARGIN)
        x2 = min(fw, x2 + VIEW_MARGIN)
        y2 = min(fh, y2 + VIEW_MARGIN)

        self.offset_x = x1
        self.offset_y = y1
        self.src_w    = x2 - x1
        self.src_h    = y2 - y1

        self.scale = min(1.0, MAX_WIN_DIM / max(self.src_w, self.src_h, 1))
        self.win_w = int(self.src_w * self.scale)
        self.win_h = int(self.src_h * self.scale)

        crop = full_bgr[y1:y2, x1:x2]
        self.base = cv2.resize(crop, (self.win_w, self.win_h),
                               interpolation=cv2.INTER_LINEAR)

    def to_full(self, dx: int, dy: int) -> Point:
        return Point(
            x=dx / self.scale + self.offset_x,
            y=dy / self.scale + self.offset_y,
        )

    def to_display(self, fx: float, fy: float) -> tuple[int, int]:
        return (
            int(round((fx - self.offset_x) * self.scale)),
            int(round((fy - self.offset_y) * self.scale)),
        )

    def render(self, clicks: list[Point], cells: list | None = None) -> np.ndarray:
        img = self.base.copy()
        if cells:
            for cx, cy, r, lbl in cells:
                dx, dy = self.to_display(cx, cy)
                cv2.circle(img, (dx, dy), max(1, int(r * self.scale)), CLR_CIRCLE, 2)
                cv2.putText(img, lbl, (dx + int(r * self.scale) + 2, dy + 4),
                            FONT, 0.30, CLR_LABEL, 1)
        for i, pt in enumerate(clicks):
            dx, dy = self.to_display(pt.x, pt.y)
            sz = 10
            cv2.line(img, (dx - sz, dy), (dx + sz, dy), CLR_CLICK, 2)
            cv2.line(img, (dx, dy - sz), (dx, dy + sz), CLR_CLICK, 2)
            cv2.circle(img, (dx, dy), 5, CLR_CLICK, -1)
            cv2.putText(img, CLICK_LABELS[i], (dx + 8, dy - 6),
                        FONT, 0.45, CLR_CLICK, 1)
        self._draw_instructions(img, len(clicks), cells is not None)
        return img

    @staticmethod
    def _draw_instructions(img: np.ndarray, n_clicks: int, done: bool) -> None:
        lines = []
        if done:
            lines += ["DONE — 4 points picked.",
                      "Press 's' to save  |  'r' to reset  |  'q' to quit"]
        else:
            remaining = CLICK_LABELS[n_clicks:]
            lines += [f"Next click: {remaining[0]}" if remaining else ""]
            lines += ["Press 'r' to reset  |  'q' to quit"]
        y = 24
        for ln in lines:
            clr = CLR_DONE if done else CLR_HINT
            cv2.putText(img, ln, (10, y), FONT, 0.55, (0, 0, 0), 3)
            cv2.putText(img, ln, (10, y), FONT, 0.55, clr, 1)
            y += 24


# ─────────────────────────────────────────────────────────────────────────────
# Interactive picking
# ─────────────────────────────────────────────────────────────────────────────

def _pick_points(full_bgr: np.ndarray, block: FieldBlockSpec) -> list[Point] | None:
    roi   = _block_roi(block, None)
    dims  = _block_dims(block)
    view  = ZoomView(full_bgr, roi)
    clicks: list[Point] = []
    result: CalibResult | None = None
    cells: list | None = None

    win = f"pick_block — {block.name}"
    cv2.namedWindow(win, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(win, view.win_w, view.win_h)

    print(f"\n  Block '{block.name}': direction={block.direction}  "
          f"rows={dims.rows}  cols={dims.cols}")
    print(f"  Block origin={block.origin}  "
          f"labelsGap={block.labels_gap}  bubblesGap={block.bubbles_gap}  "
          f"bubbleDimensions={block.bubble_dimensions}")
    print("  Click 4 bubble centers in order:")
    for lbl in CLICK_LABELS:
        print(f"    {lbl}")
    print("  Keys: 'r' reset  |  's' save  |  'q' quit\n")

    save_requested = False
    bubble_size: int | None = _pick_points._bubble_size

    def on_mouse(event, x, y, flags, param):
        nonlocal result, cells
        if event == cv2.EVENT_LBUTTONDOWN and len(clicks) < 4:
            pt = view.to_full(x, y)
            clicks.append(pt)
            n = len(clicks)
            print(f"  [click {n}] {CLICK_LABELS[n-1]:20s}  "
                  f"display=({x}, {y})  full=({pt.x:.1f}, {pt.y:.1f})")
            if n == 4:
                bw = block.bubble_dimensions[0] if bubble_size is None else bubble_size
                bh = block.bubble_dimensions[1] if bubble_size is None else bubble_size
                result = _compute_params(
                    clicks[0], clicks[1], clicks[2], clicks[3],
                    dims, [bw, bh], direction=block.direction,
                )
                cells = _generate_preview_bubbles(result, dims, block)
                _print_result(result, dims, block, _pick_points._page_dimensions)

    cv2.setMouseCallback(win, on_mouse)

    while True:
        frame = view.render(clicks, cells if len(clicks) == 4 else None)
        cv2.imshow(win, frame)
        key = cv2.waitKey(20) & 0xFF

        if key == ord('r'):
            clicks.clear()
            result = None
            cells  = None
            print("  [reset] clicks cleared")
        elif key == ord('s') and len(clicks) == 4:
            save_requested = True
            break
        elif key == ord('q'):
            break

    cv2.destroyAllWindows()

    if len(clicks) == 4:
        _pick_points._last_result    = result
        _pick_points._last_cells     = cells
        _pick_points._save_requested = save_requested
        return clicks
    return None


_pick_points._bubble_size     = None
_pick_points._page_dimensions = [2550, 3301]
_pick_points._last_result     = None
_pick_points._last_cells      = None
_pick_points._save_requested  = False


# ─────────────────────────────────────────────────────────────────────────────
# Validation + printing
# ─────────────────────────────────────────────────────────────────────────────

def _validate_block(
    result: CalibResult, dims: BlockDims,
    block: FieldBlockSpec, page_dimensions: list[int],
) -> list[str]:
    errors: list[str] = []
    rows, cols = dims.rows, dims.cols
    w, h = result.bubble_dim
    ox, oy = result.origin
    pw, ph = page_dimensions
    direction = block.direction

    if direction == "vertical":
        x_step, y_step = result.labels_gap, result.bubbles_gap
        for ci in range(cols):
            for ri in range(rows):
                bx = int(round(ox + ci * x_step))
                by = int(round(oy + ri * y_step))
                if bx < 0 or by < 0 or bx + w > pw or by + h > ph:
                    lbl = block.field_labels[ci] if ci < len(block.field_labels) else f"col{ci}"
                    val = block.bubble_values[ri] if ri < len(block.bubble_values) else f"row{ri}"
                    errors.append(f"  OOB: {lbl}/{val} bubble=({bx},{by},{w},{h}) page={pw}×{ph}")
    else:
        x_step, y_step = result.bubbles_gap, result.labels_gap
        for ri in range(rows):
            for ci in range(cols):
                bx = int(round(ox + ci * x_step))
                by = int(round(oy + ri * y_step))
                if bx < 0 or by < 0 or bx + w > pw or by + h > ph:
                    lbl = block.field_labels[ri] if ri < len(block.field_labels) else f"row{ri}"
                    val = block.bubble_values[ci] if ci < len(block.bubble_values) else f"col{ci}"
                    errors.append(f"  OOB: {lbl}/{val} bubble=({bx},{by},{w},{h}) page={pw}×{ph}")
    return errors


def _print_result(
    result: CalibResult, dims: BlockDims,
    block: FieldBlockSpec, page_dimensions: list[int],
) -> None:
    rows, cols = dims.rows, dims.cols
    w, h = result.bubble_dim
    ox, oy = result.origin
    direction = block.direction

    if direction == "vertical":
        last_x = int(round(ox + (cols - 1) * result.labels_gap))
        last_y = int(round(oy + (rows - 1) * result.bubbles_gap))
    else:
        last_x = int(round(ox + (cols - 1) * result.bubbles_gap))
        last_y = int(round(oy + (rows - 1) * result.labels_gap))

    print("\n  ── Suggested template update ──────────────────────────────")
    print(f"  direction : {direction}  rows×cols : {rows}×{cols}")
    print(json.dumps({
        "origin":           result.origin,
        "bubbleDimensions": result.bubble_dim,
        "bubblesGap":       round(result.bubbles_gap, 2),
        "labelsGap":        round(result.labels_gap,  2),
    }, indent=4))
    pw, ph = page_dimensions
    print(f"  last bubble top-left=({last_x},{last_y})  page={pw}×{ph}")

    errors = _validate_block(result, dims, block, page_dimensions)
    if errors:
        print(f"  [WARN] {len(errors)} bubble(s) out-of-bounds — SAVE BLOCKED")
        for e in errors[:10]: print(e)
        if len(errors) > 10: print(f"  ... +{len(errors)-10} more")
    else:
        print("  [OK] all bubbles within page bounds")
    print("  ───────────────────────────────────────────────────────────\n")


# ─────────────────────────────────────────────────────────────────────────────
# Preview image
# ─────────────────────────────────────────────────────────────────────────────

def _save_preview(
    full_bgr: np.ndarray, block: FieldBlockSpec,
    result: CalibResult, cells: list,
    clicks: list[Point], out_dir: Path,
) -> Path:
    vis = full_bgr.copy()
    w, h = result.bubble_dim
    for cx, cy, r, lbl in cells:
        cv2.circle(vis, (cx, cy), r, CLR_CIRCLE, 2)
        cv2.rectangle(vis,
            (cx - w // 2, cy - h // 2), (cx + w // 2, cy + h // 2),
            (180, 180, 0), 1)
        cv2.putText(vis, lbl, (cx + r + 2, cy + 4), FONT, 0.28, CLR_LABEL, 1)
    for i, pt in enumerate(clicks):
        ix, iy = int(round(pt.x)), int(round(pt.y))
        cv2.circle(vis, (ix, iy), 8, CLR_CLICK, -1)
        cv2.putText(vis, CLICK_LABELS[i], (ix + 10, iy - 5),
                    FONT, 0.45, CLR_CLICK, 1)
    xs = [cx for cx, cy, r, _ in cells]
    ys = [cy for cx, cy, r, _ in cells]
    margin = 120
    fh, fw = vis.shape[:2]
    x1 = max(0, min(xs) - w // 2 - margin)
    y1 = max(0, min(ys) - h // 2 - margin)
    x2 = min(fw, max(xs) + w // 2 + margin)
    y2 = min(fh, max(ys) + h // 2 + margin)
    crop = vis[y1:y2, x1:x2]
    ch, cw = crop.shape[:2]
    scale = min(1.0, 1600 / max(cw, ch, 1))
    if scale < 1.0:
        crop = cv2.resize(crop, (int(cw * scale), int(ch * scale)))
    out_path = out_dir / f"pick_{block.name}_preview.jpg"
    cv2.imwrite(str(out_path), crop, [cv2.IMWRITE_JPEG_QUALITY, 93])
    print(f"  [preview] → {out_path}  ({crop.shape[1]}×{crop.shape[0]})")
    return out_path


# ─────────────────────────────────────────────────────────────────────────────
# Template write-back
# ─────────────────────────────────────────────────────────────────────────────

def _save_to_template(
    template_path: Path, block_name: str,
    result: CalibResult, dims: BlockDims,
    block: FieldBlockSpec, page_dimensions: list[int],
) -> bool:
    errors = _validate_block(result, dims, block, page_dimensions)
    if errors:
        print(f"\n  [BLOCKED] {len(errors)} bubble(s) out-of-bounds — NOT saving.")
        for e in errors[:15]: print(e)
        return False

    backup = template_path.with_name(template_path.stem + ".backup.json")
    shutil.copy2(template_path, backup)
    print(f"  [backup] {backup}")

    with open(template_path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    block_raw = raw["fieldBlocks"].get(block_name)
    if block_raw is None:
        print(f"  [ERROR] block '{block_name}' not in template JSON")
        return False

    block_raw["origin"]           = result.origin
    block_raw["bubbleDimensions"] = result.bubble_dim
    block_raw["labelsGap"]        = int(round(result.labels_gap))
    block_raw["bubblesGap"]       = int(round(result.bubbles_gap))

    with open(template_path, "w", encoding="utf-8") as f:
        json.dump(raw, f, ensure_ascii=False, indent=2)

    print(f"\n  [SAVED] {template_path}")
    print(f"    origin           = {result.origin}")
    print(f"    bubbleDimensions = {result.bubble_dim}")
    print(f"    labelsGap        = {int(round(result.labels_gap))}")
    print(f"    bubblesGap       = {int(round(result.bubbles_gap))}")

    try:
        load_template(template_path)
        print("  [OK] template re-loads cleanly.")
    except Exception as e:
        print(f"  [WARN] template re-load failed: {e}")

    return True


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Click-to-calibrate: pick 4 bubble centers on ALIGNED image.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python scripts/pick_block_points.py uploads/raw.jpg --block Block_CCCD
  python scripts/pick_block_points.py uploads/raw.jpg --block Block_CCCD \\
      --bubble-size 32 --save
  python scripts/pick_block_points.py aligned.jpg --block Block_CCCD \\
      --already-aligned --save
  python scripts/pick_block_points.py uploads/raw.jpg --block Block_Toan \\
      --no-crop --save-aligned-debug --save
        """,
    )
    p.add_argument("image",       help="Path to answer sheet image")
    p.add_argument("--block",     required=True, metavar="BLOCK_NAME",
                   help="fieldBlock name to calibrate (e.g. Block_CCCD)")
    p.add_argument("--bubble-size", type=int, default=None, metavar="PX",
                   help="Square bubble size in px (default: from template)")
    p.add_argument("--template",  default=str(DEFAULT_TEMPLATE), metavar="PATH")
    p.add_argument("--out-dir",   default=str(DEFAULT_OUT_DIR),  metavar="PATH")
    p.add_argument("--save",      action="store_true",
                   help="Write params to template JSON after picking")
    p.add_argument("--no-save-preview", action="store_true",
                   help="Skip writing preview image")
    # ── Alignment mode flags ───────────────────────────────────────────────
    p.add_argument("--already-aligned", action="store_true",
                   help="Input image is already aligned; skip all preprocessing. "
                        "Pick directly on the input image as-is.")
    p.add_argument("--no-crop",    action="store_true",
                   help="Skip CropOnMarkers; use plain resize to pageDimensions instead")
    p.add_argument("--save-aligned-debug", action="store_true",
                   help="Save the image used for picking to "
                        "outputs/debug_overlays/pick_<block>_aligned_input.jpg")
    return p.parse_args()


def main() -> None:
    args = parse_args()

    # ── Paths ─────────────────────────────────────────────────────────────────
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

    # ── Load template ─────────────────────────────────────────────────────────
    print(f"\n[1/4] Loading template: {template_path}")
    tpl   = load_template(template_path)
    block = next((b for b in tpl.field_blocks if b.name == args.block), None)
    if block is None:
        available = [b.name for b in tpl.field_blocks]
        print(f"[ERROR] Block '{args.block}' not found.\nAvailable: {', '.join(available)}",
              file=sys.stderr)
        sys.exit(1)

    dims = _block_dims(block)
    bw   = args.bubble_size if args.bubble_size else block.bubble_dimensions[0]
    bh   = args.bubble_size if args.bubble_size else block.bubble_dimensions[1]

    print(f"      block '{block.name}': direction={block.direction} "
          f"rows={dims.rows} cols={dims.cols} "
          f"bubble={bw}×{bh}")
    print(f"      block origin={block.origin}  "
          f"labelsGap={block.labels_gap}  bubblesGap={block.bubbles_gap}")
    print(f"      template pageDimensions: {tpl.page_dimensions[0]}×{tpl.page_dimensions[1]}")

    # ── Load raw image ────────────────────────────────────────────────────────
    print(f"\n[2/4] Loading image: {image_path}")
    raw = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE)
    if raw is None:
        print(f"[ERROR] Cannot read image: {image_path}", file=sys.stderr)
        sys.exit(1)

    # ── Align ─────────────────────────────────────────────────────────────────
    print(f"\n[3/4] Aligning image …")
    aligned_gray = _align_image(
        raw, tpl,
        already_aligned=args.already_aligned,
        no_crop=args.no_crop,
    )
    aligned_bgr = cv2.cvtColor(aligned_gray, cv2.COLOR_GRAY2BGR)

    # ── Save aligned debug image ──────────────────────────────────────────────
    if args.save_aligned_debug:
        debug_path = out_dir / f"pick_{args.block}_aligned_input.jpg"
        cv2.imwrite(str(debug_path), aligned_bgr, [cv2.IMWRITE_JPEG_QUALITY, 93])
        print(f"  [debug] aligned input saved → {debug_path}")

    # ── Interactive pick ──────────────────────────────────────────────────────
    print(f"\n[4/4] Opening calibration window …")
    _pick_points._bubble_size     = args.bubble_size
    _pick_points._page_dimensions = tpl.page_dimensions

    clicks = _pick_points(aligned_bgr, block)

    if clicks is None or len(clicks) < 4:
        print("\nNo complete pick — exiting without changes.")
        sys.exit(0)

    result       = _pick_points._last_result
    cells        = _pick_points._last_cells
    save_via_key = _pick_points._save_requested

    # ── Preview ───────────────────────────────────────────────────────────────
    if not args.no_save_preview:
        _save_preview(aligned_bgr, block, result, cells, clicks, out_dir)

    # ── Save ──────────────────────────────────────────────────────────────────
    if args.save or save_via_key:
        _save_to_template(
            template_path, args.block, result,
            dims=dims, block=block,
            page_dimensions=tpl.page_dimensions,
        )
    else:
        print("\nRun with --save (or press 's') to write to template.")

    print("\nDone.")


if __name__ == "__main__":
    main()
