#!/usr/bin/env python3
"""
create_vju_marker_asset.py
==========================
Crop 4 corner registration markers from a clean VJU answer-sheet image and
produce a single averaged marker template suitable for use as a reference
asset.

Usage
-----
Auto-detect (recommended — uses the production contour detector):
    python scripts/create_vju_marker_asset.py <image_path>

Manual coordinates (top-left pixel of each marker square):
    python scripts/create_vju_marker_asset.py <image_path> \\
        --tl 75,285 --tr 1142,285 --bl 72,1611 --br 1139,1611 \\
        --size 70 --pad 12

Verify existing asset against a set of images:
    python scripts/create_vju_marker_asset.py --verify <img1> <img2> ...

Outputs
-------
    backend/assets/markers/vju_marker.png
    backend/outputs/debug_overlays/marker_crop_debug.jpg
    backend/outputs/debug_overlays/marker_crops_grid.jpg  (individual crops)

Notes
-----
* The production CropOnMarkers pipeline uses contour-based detection, not
  cv2.matchTemplate, so this asset is currently a reference / future use.
* Only use clean scan images (no overlay, no browser screenshots).
* Each marker crop is normalised, centred on a white canvas and binarised
  before blending so the final asset is crisp black-on-white.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
import cv2
import numpy as np

# ── Path setup ────────────────────────────────────────────────────────────────
SCRIPT_DIR   = Path(__file__).resolve().parent
BACKEND_DIR  = SCRIPT_DIR.parent
ASSET_PATH   = BACKEND_DIR / "assets" / "markers" / "vju_marker.png"
DEBUG_DIR    = BACKEND_DIR / "outputs" / "debug_overlays"

# Production CropOnMarkers (used in auto-detect mode)
sys.path.insert(0, str(BACKEND_DIR))


# ── Constants ─────────────────────────────────────────────────────────────────

DEFAULT_OUTPUT_SIZE = 70   # final asset side length (px)
DEFAULT_PAD         = 12   # white padding around bare marker crop (px)
BINARISE_THR        = 127  # threshold for cleaning up each crop


# ── Core helpers ──────────────────────────────────────────────────────────────

def _auto_detect_markers(gray: np.ndarray) -> dict[str, tuple[float, float, float]]:
    """
    Run the production contour detector and return
    { "TL": (cx, cy, area), "TR": ..., "BL": ..., "BR": ... }.
    Raises RuntimeError if fewer than 4 markers are found.
    """
    from app.core.omr.crop_on_markers import crop_on_markers

    result = crop_on_markers(gray, debug=False)
    if not result.success or not result.marker_centers:
        raise RuntimeError(
            f"Auto-detect failed: {result.reason}. "
            "Try --tl/--tr/--bl/--br with manual pixel coordinates."
        )
    if len(result.marker_centers) < 4:
        raise RuntimeError(
            f"Only {len(result.marker_centers)} markers found (need 4). "
            "Try manual coordinates."
        )
    out: dict[str, tuple[float, float, float]] = {}
    for mc in result.marker_centers:
        out[mc["quad"]] = (mc["cx"], mc["cy"], mc["area"])
    # Verify all four quads present
    for q in ("TL", "TR", "BL", "BR"):
        if q not in out:
            raise RuntimeError(f"Quadrant {q} not detected. Try manual coordinates.")
    return out


def _estimate_marker_size(area: float) -> int:
    """Estimate marker side length from detected blob area."""
    return max(10, int(np.sqrt(area)))


def _crop_marker(
    gray: np.ndarray,
    cx: float,
    cy: float,
    marker_side: int,
    pad: int,
) -> np.ndarray:
    """
    Crop a region centred at (cx, cy) that covers the marker + padding.
    Returns a grayscale patch.
    """
    h, w = gray.shape[:2]
    half = marker_side // 2 + pad
    x1 = max(0, int(cx) - half)
    y1 = max(0, int(cy) - half)
    x2 = min(w, int(cx) + half + (marker_side % 2))
    y2 = min(h, int(cy) + half + (marker_side % 2))
    return gray[y1:y2, x1:x2].copy()


def _normalise_crop(
    crop: np.ndarray,
    output_size: int,
    binarise_thr: int = BINARISE_THR,
) -> np.ndarray:
    """
    Normalise a raw marker crop:
    1. Binarise (Otsu) — separate ink from paper.
    2. Find tight bounding box of the dark blob.
    3. Place it centred on a white output_size × output_size canvas
       with equal white margin all around.
    Returns a uint8 grayscale image.
    """
    # Binarise
    _, bw = cv2.threshold(crop, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)

    # Tightest bounding box of dark region
    cnts, _ = cv2.findContours(bw, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        # Fallback: return white canvas (nothing to crop)
        return np.full((output_size, output_size), 255, dtype=np.uint8)

    # Pick largest contour
    c = max(cnts, key=cv2.contourArea)
    bx, by, bw_c, bh_c = cv2.boundingRect(c)

    # Extract tight patch from original (grayscale, not binarised)
    tight = crop[by : by + bh_c, bx : bx + bw_c]

    # Resize to fit inside (output_size - 2*margin) with aspect preserved
    margin = output_size // 6            # white margin on each side
    max_inner = output_size - 2 * margin
    scale = min(max_inner / max(bw_c, 1), max_inner / max(bh_c, 1))
    new_w = max(1, int(bw_c * scale))
    new_h = max(1, int(bh_c * scale))
    resized = cv2.resize(tight, (new_w, new_h), interpolation=cv2.INTER_AREA)

    # Place on white canvas
    canvas = np.full((output_size, output_size), 255, dtype=np.uint8)
    y_off = (output_size - new_h) // 2
    x_off = (output_size - new_w) // 2
    canvas[y_off : y_off + new_h, x_off : x_off + new_w] = resized

    # Final binarise to remove JPEG/scan artefacts
    _, clean = cv2.threshold(canvas, binarise_thr, 255, cv2.THRESH_BINARY)
    return clean


def _blend_markers(crops: list[np.ndarray]) -> np.ndarray:
    """
    Blend normalised marker crops using pixel-wise median.
    All crops must have the same shape.
    Returns a binary (0/255) image.
    """
    stack = np.stack(crops, axis=0).astype(np.float32)
    med   = np.median(stack, axis=0)
    # Re-binarise the median
    _, result = cv2.threshold(med.astype(np.uint8), BINARISE_THR, 255, cv2.THRESH_BINARY)
    return result


def _draw_debug_image(
    img_color: np.ndarray,
    quads: dict[str, tuple[float, float, float]],
    marker_side: int,
    pad: int,
) -> np.ndarray:
    """
    Draw labelled boxes around all 4 detected markers on a colour copy of img.
    Returns the annotated BGR image.
    """
    vis = img_color.copy() if len(img_color.shape) == 3 else cv2.cvtColor(img_color, cv2.COLOR_GRAY2BGR)
    h, w = vis.shape[:2]
    scale = max(1, w // 800)          # line thickness scaled to image size
    font_scale = max(0.4, scale * 0.5)

    colours = {
        "TL": (0,   200,  0),    # green
        "TR": (255, 128,  0),    # orange
        "BL": (0,   128, 255),   # blue
        "BR": (0,     0, 255),   # red
    }

    half = marker_side // 2 + pad
    for quad, (cx, cy, area) in quads.items():
        x1 = max(0, int(cx) - half)
        y1 = max(0, int(cy) - half)
        x2 = min(w, int(cx) + half)
        y2 = min(h, int(cy) + half)
        col = colours.get(quad, (200, 200, 200))

        # Outer box (read area)
        cv2.rectangle(vis, (x1, y1), (x2, y2), col, scale * 2)
        # Inner crosshair at marker centre
        cv2.circle(vis, (int(cx), int(cy)), scale * 3, col, -1)
        # Label
        label = f"{quad}  area={int(area)}"
        ly = max(y1 - 6, 14)
        cv2.putText(vis, label, (x1, ly), cv2.FONT_HERSHEY_SIMPLEX,
                    font_scale, col, max(1, scale), cv2.LINE_AA)

    return vis


def _draw_crops_grid(crops: dict[str, np.ndarray], blended: np.ndarray) -> np.ndarray:
    """
    Arrange the 4 individual crops + the blended result in a 3×2 grid.
    All images are uint8 grayscale, converted to BGR for the grid.
    """
    order = ["TL", "TR", "BL", "BR"]
    cells = [cv2.cvtColor(crops[q], cv2.COLOR_GRAY2BGR) for q in order]
    # Blended in centre slot
    blended_bgr = cv2.cvtColor(blended, cv2.COLOR_GRAY2BGR)
    # Put a yellow border on the blended cell
    cv2.rectangle(blended_bgr, (0, 0),
                  (blended_bgr.shape[1]-1, blended_bgr.shape[0]-1),
                  (0, 200, 255), 3)

    # Labels on each cell
    labels = order + ["BLEND"]
    all_cells = cells + [blended_bgr]
    sz = all_cells[0].shape[0]

    for i, (cell, lbl) in enumerate(zip(all_cells, labels)):
        cv2.putText(cell, lbl, (4, sz - 6), cv2.FONT_HERSHEY_SIMPLEX,
                    0.5, (50, 50, 200), 1, cv2.LINE_AA)

    # Layout: row 0 = TL TR BL, row 1 = BR [blank] BLEND
    pad_cell = np.full((sz, sz, 3), 240, dtype=np.uint8)
    row0 = np.hstack(all_cells[:3])
    row1 = np.hstack([all_cells[3], pad_cell, all_cells[4]])
    grid = np.vstack([row0, row1])
    return grid


# ── Main crop pipeline ────────────────────────────────────────────────────────

def create_marker_asset(
    image_path: str,
    manual_coords: dict[str, tuple[int, int]] | None = None,
    output_size: int = DEFAULT_OUTPUT_SIZE,
    pad: int = DEFAULT_PAD,
    asset_path: Path = ASSET_PATH,
    debug_dir: Path = DEBUG_DIR,
) -> Path:
    """
    Full pipeline: detect → crop → normalise → blend → save.
    Returns path to saved asset.
    """
    # ── Load image ────────────────────────────────────────────────────────────
    img_color = cv2.imread(image_path)
    if img_color is None:
        raise FileNotFoundError(f"Cannot read image: {image_path}")
    gray = cv2.cvtColor(img_color, cv2.COLOR_BGR2GRAY) if len(img_color.shape) == 3 else img_color

    h, w = gray.shape[:2]
    print(f"[create_marker_asset] Image: {Path(image_path).name}  {w}×{h}")

    # ── Detect markers ────────────────────────────────────────────────────────
    if manual_coords:
        print("[create_marker_asset] Using manual coordinates")
        # Convert {quad: (x,y)} → {quad: (cx, cy, area)}
        #   x,y is top-left of the marker square;
        #   we need to estimate the size.  Use a local contour search to find it.
        quads: dict[str, tuple[float, float, float]] = {}
        for quad, (mx, my) in manual_coords.items():
            # Search a 60×60 region around the given point for a dark blob
            search_r = 30
            sx1, sy1 = max(0, mx - search_r), max(0, my - search_r)
            sx2, sy2 = min(w, mx + search_r + 60), min(h, my + search_r + 60)
            roi = gray[sy1:sy2, sx1:sx2]
            _, bw = cv2.threshold(roi, 100, 255, cv2.THRESH_BINARY_INV)
            cnts, _ = cv2.findContours(bw, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if cnts:
                c = max(cnts, key=cv2.contourArea)
                bx, by, bw_c, bh_c = cv2.boundingRect(c)
                area = cv2.contourArea(c)
                cx = sx1 + bx + bw_c / 2
                cy = sy1 + by + bh_c / 2
            else:
                # Fall back to given point
                cx, cy, area = mx + 12, my + 12, 400.0
                print(f"  ⚠  {quad}: no contour near {mx},{my} — using raw coords")
            quads[quad] = (cx, cy, area)
            print(f"  {quad}: centre=({cx:.1f},{cy:.1f})  area={area:.0f}")
    else:
        print("[create_marker_asset] Running auto-detect …")
        quads = _auto_detect_markers(gray)
        for q, (cx, cy, area) in quads.items():
            print(f"  {q}: centre=({cx:.1f},{cy:.1f})  area={area:.0f}")

    # ── Estimate marker physical size ─────────────────────────────────────────
    areas = [v[2] for v in quads.values()]
    avg_area = float(np.median(areas))
    marker_side = _estimate_marker_size(avg_area)
    print(f"[create_marker_asset] Estimated marker side: {marker_side}px  "
          f"(median area={avg_area:.0f})")

    # ── Crop each marker ───────────────────────────────────────────────────────
    raw_crops:  dict[str, np.ndarray] = {}
    norm_crops: dict[str, np.ndarray] = {}
    for quad, (cx, cy, _) in quads.items():
        raw  = _crop_marker(gray, cx, cy, marker_side, pad)
        norm = _normalise_crop(raw, output_size)
        raw_crops[quad]  = raw
        norm_crops[quad] = norm
        dark_pct = (norm < 128).mean() * 100
        print(f"  {quad}: raw={raw.shape}  norm={norm.shape}  dark%={dark_pct:.1f}")

    # ── Blend ─────────────────────────────────────────────────────────────────
    blended = _blend_markers(list(norm_crops.values()))
    dark_pct = (blended < 128).mean() * 100
    print(f"[create_marker_asset] Blended asset: {output_size}×{output_size}  "
          f"dark%={dark_pct:.1f}")

    # ── Sanity check ──────────────────────────────────────────────────────────
    if dark_pct < 5:
        print("  ⚠  WARNING: blended asset is almost entirely white — marker not detected properly.")
        print("     Consider using --tl/--tr/--bl/--br to specify exact coordinates.")
    elif dark_pct > 60:
        print("  ⚠  WARNING: blended asset is very dark — possible noise contamination.")

    # ── Save asset ────────────────────────────────────────────────────────────
    asset_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(asset_path), blended)
    print(f"[create_marker_asset] Saved asset → {asset_path}")

    # ── Debug images ──────────────────────────────────────────────────────────
    debug_dir.mkdir(parents=True, exist_ok=True)

    # Annotated original
    debug_img = _draw_debug_image(img_color, quads, marker_side, pad)
    debug_path = debug_dir / "marker_crop_debug.jpg"
    cv2.imwrite(str(debug_path), debug_img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    print(f"[create_marker_asset] Saved debug  → {debug_path}")

    # Crops grid
    grid = _draw_crops_grid(norm_crops, blended)
    grid_path = debug_dir / "marker_crops_grid.jpg"
    cv2.imwrite(str(grid_path), grid, [cv2.IMWRITE_JPEG_QUALITY, 95])
    print(f"[create_marker_asset] Saved grid   → {grid_path}")

    return asset_path


# ── Verify mode ───────────────────────────────────────────────────────────────

def verify_detection(image_paths: list[str]) -> None:
    """
    Run crop_on_markers() on each image and print a summary table.
    Also calls the production pipeline so marker_quality_score is shown.
    """
    from app.core.omr.crop_on_markers import crop_on_markers

    print("\n" + "="*70)
    print(f"{'Image':<35} {'Stage':>5} {'Quality':>8} {'Warp':>5} {'Reason'}")
    print("="*70)

    for path in image_paths:
        img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
        if img is None:
            print(f"{'(cannot read) ' + Path(path).name:<35}  —")
            continue
        result = crop_on_markers(img, debug=False)
        name = Path(path).name[:34]
        stage = result.prep_stage if result.prep_stage >= 0 else "—"
        q     = f"{result.marker_quality_score:.3f}" if result.success else "—"
        warp  = "YES" if result.warp_used else "no"
        reason = result.reason
        print(f"{name:<35} {str(stage):>5} {q:>8} {warp:>5}  {reason}")

        if result.success and result.marker_centers:
            for mc in result.marker_centers:
                print(f"    {mc['quad']}: cx={mc['cx']:.0f} cy={mc['cy']:.0f} "
                      f"area={mc['area']:.0f} sol={mc['solidity']:.3f}")
    print("="*70 + "\n")


# ── CLI ───────────────────────────────────────────────────────────────────────

def _parse_coord(s: str) -> tuple[int, int]:
    parts = s.strip().split(",")
    if len(parts) != 2:
        raise argparse.ArgumentTypeError(f"Coordinate must be x,y — got '{s}'")
    return int(parts[0]), int(parts[1])


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Create a clean VJU marker template from a scan image.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Auto-detect markers
  python scripts/create_vju_marker_asset.py uploads/baidato_page-0007.jpg

  # Manual coordinates (top-left pixel of each marker square)
  python scripts/create_vju_marker_asset.py uploads/baidato_page-0007.jpg \\
      --tl 75,285 --tr 1142,285 --bl 72,1611 --br 1139,1611 --size 70 --pad 12

  # Verify detection quality on multiple images
  python scripts/create_vju_marker_asset.py --verify uploads/*.jpg
""",
    )

    parser.add_argument("image", nargs="?", help="Path to source scan image")
    parser.add_argument("--tl",   type=_parse_coord, help="Top-left marker: x,y")
    parser.add_argument("--tr",   type=_parse_coord, help="Top-right marker: x,y")
    parser.add_argument("--bl",   type=_parse_coord, help="Bottom-left marker: x,y")
    parser.add_argument("--br",   type=_parse_coord, help="Bottom-right marker: x,y")
    parser.add_argument("--size", type=int, default=DEFAULT_OUTPUT_SIZE,
                        help=f"Output asset size in px (default {DEFAULT_OUTPUT_SIZE})")
    parser.add_argument("--pad",  type=int, default=DEFAULT_PAD,
                        help=f"White padding around marker in px (default {DEFAULT_PAD})")
    parser.add_argument("--out",  type=str, default=str(ASSET_PATH),
                        help="Output asset path (default: assets/markers/vju_marker.png)")
    parser.add_argument("--verify", nargs="+", metavar="IMAGE",
                        help="Verify-only mode: run crop_on_markers on these images")

    args = parser.parse_args()

    # ── Verify mode ───────────────────────────────────────────────────────────
    if args.verify:
        verify_detection(args.verify)
        return

    # ── Crop mode ─────────────────────────────────────────────────────────────
    if not args.image:
        parser.error("image path is required (or use --verify)")

    manual: dict[str, tuple[int, int]] | None = None
    if any([args.tl, args.tr, args.bl, args.br]):
        missing = [k for k, v in [("TL",args.tl),("TR",args.tr),
                                   ("BL",args.bl),("BR",args.br)] if v is None]
        if missing:
            parser.error(f"Must specify all 4 corners if using manual mode. Missing: {missing}")
        manual = {"TL": args.tl, "TR": args.tr, "BL": args.bl, "BR": args.br}

    asset_out = create_marker_asset(
        image_path   = args.image,
        manual_coords = manual,
        output_size  = args.size,
        pad          = args.pad,
        asset_path   = Path(args.out),
        debug_dir    = DEBUG_DIR,
    )
    print(f"\n✓  Asset written to: {asset_out}")
    print(f"   Debug image:       {DEBUG_DIR / 'marker_crop_debug.jpg'}")
    print(f"   Crops grid:        {DEBUG_DIR / 'marker_crops_grid.jpg'}")


if __name__ == "__main__":
    main()
