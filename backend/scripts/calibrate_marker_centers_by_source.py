"""
calibrate_marker_centers_by_source.py
======================================
Đo marker centers từ một ảnh scan thực tế, scale về pageDimensions,
và ghi kết quả vào template JSON dưới key markerCentersInTemplateBySource.

Mục đích: mỗi image_source (flatbed, scan_app, camera, ...) có thể có
tỷ lệ marker H/V span khác nhau. Calibration riêng giúp tránh anisotropic
H-stretch khi warp.

Usage:
  # In ra JSON block, không ghi file
  python scripts/calibrate_marker_centers_by_source.py uploads/Scan\ Enhance_9.JPG \\
    --template templates/vju_main_template.calibrated.json \\
    --source scan_app

  # Ghi thẳng vào template JSON
  python scripts/calibrate_marker_centers_by_source.py uploads/Scan\ Enhance_9.JPG \\
    --template templates/vju_main_template.calibrated.json \\
    --source scan_app --write

  # Calibrate nhiều ảnh cùng lúc (lấy median centers)
  python scripts/calibrate_marker_centers_by_source.py uploads/scan_enhance_*.jpg \\
    --template templates/vju_main_template.calibrated.json \\
    --source scan_app --write

  # Calibrate cả 2 templates cùng lúc
  python scripts/calibrate_marker_centers_by_source.py uploads/scan_enhance_3.jpg \\
    --template templates/vju_main_template.calibrated.json \\
               templates/vju_sbd4_template.calibrated.json \\
    --source scan_app --write
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

# ── allow running from backend/ root ────────────────────────────────────────
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.core.omr.crop_on_markers import crop_on_markers
from app.core.templates.template_loader import load_template


QUAD_COLORS = {
    "TL": (0, 200, 0),
    "TR": (0, 120, 255),
    "BR": (0, 0, 220),
    "BL": (200, 0, 220),
}
QUAD_ORDER = ("TL", "TR", "BR", "BL")


# ── Single-image detection ────────────────────────────────────────────────────

def detect_and_scale(
    image_path: str | Path,
    template_path: str | Path,
) -> dict | None:
    """
    Detect 4 marker centers in *image_path* and scale them to pageDimensions.

    Returns dict with keys: TL, TR, BR, BL → [x_scaled, y_scaled]
    or None if detection failed.
    """
    img = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE)
    if img is None:
        print(f"  ERROR: cannot read image: {image_path}", file=sys.stderr)
        return None

    tpl = load_template(str(template_path))
    pw, ph = tpl.page_dimensions
    orig_h, orig_w = img.shape[:2]

    # Use existing marker_centers_in_template (if any) just to run the detector;
    # we want raw detected positions, not a calibrated warp.
    result = crop_on_markers(
        img,
        target_size=(pw, ph),
        debug=False,
        marker_centers_in_template=None,   # legacy mode — detect only
        min_warp_quality=0.0,              # always report, even low quality
    )

    if not result.success or result.marker_pts is None:
        print(f"  ERROR: could not detect 4 markers in {image_path}", file=sys.stderr)
        print(f"  reason: {result.reason}", file=sys.stderr)
        return None

    scale_x = pw / orig_w
    scale_y = ph / orig_h

    scaled: dict[str, list[int]] = {}
    for i, q in enumerate(QUAD_ORDER):
        raw_cx = float(result.marker_pts[i][0])
        raw_cy = float(result.marker_pts[i][1])
        scaled[q] = [round(raw_cx * scale_x), round(raw_cy * scale_y)]

    return {
        "scaled_centers": scaled,
        "raw_centers": {
            q: [float(result.marker_pts[i][0]), float(result.marker_pts[i][1])]
            for i, q in enumerate(QUAD_ORDER)
        },
        "original_size": (orig_w, orig_h),
        "page_dimensions": (pw, ph),
        "quality_score": result.marker_quality_score,
        "marker_result": result,
    }


# ── Debug image ───────────────────────────────────────────────────────────────

def save_debug_image(
    image_path: str | Path,
    detection: dict,
    source_label: str,
    out_dir: str | Path = "outputs/debug_overlays",
) -> Path:
    """Draw detected marker centers + scale info on original image."""
    img_bgr = cv2.imread(str(image_path))
    if img_bgr is None:
        img_gray = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE)
        img_bgr = cv2.cvtColor(img_gray, cv2.COLOR_GRAY2BGR)

    orig_h, orig_w = img_bgr.shape[:2]
    pw, ph = detection["page_dimensions"]

    # Compute anisotropy of the scaled result
    scaled = detection["scaled_centers"]
    tl_s = np.array(detection["raw_centers"]["TL"])
    tr_s = np.array(detection["raw_centers"]["TR"])
    br_s = np.array(detection["raw_centers"]["BR"])
    bl_s = np.array(detection["raw_centers"]["BL"])
    src_h_span = float(np.linalg.norm(tr_s - tl_s))
    src_v_span = float(np.linalg.norm(bl_s - tl_s))

    tl_d = np.array(scaled["TL"], float)
    tr_d = np.array(scaled["TR"], float)
    br_d = np.array(scaled["BR"], float)
    bl_d = np.array(scaled["BL"], float)
    dst_h_span = float(np.linalg.norm(tr_d - tl_d))
    dst_v_span = float(np.linalg.norm(bl_d - tl_d))
    h_scale = dst_h_span / src_h_span if src_h_span > 0 else 0
    v_scale = dst_v_span / src_v_span if src_v_span > 0 else 0
    delta_aniso = (h_scale - v_scale) * 100

    font = cv2.FONT_HERSHEY_SIMPLEX
    scale_f = min(orig_w, orig_h) / 1200.0
    r_size = max(18, int(min(orig_w, orig_h) * 0.012))

    mr = detection["marker_result"]

    # Draw polygon
    poly_pts = np.array([[int(mr.marker_pts[i][0]), int(mr.marker_pts[i][1])] for i in range(4)], np.int32)
    cv2.polylines(img_bgr, [poly_pts], True, (0, 200, 200), 3)

    # Draw each marker center
    for i, q in enumerate(QUAD_ORDER):
        cx = int(mr.marker_pts[i][0])
        cy = int(mr.marker_pts[i][1])
        color = QUAD_COLORS[q]
        cv2.circle(img_bgr, (cx, cy), r_size, color, -1)
        cv2.circle(img_bgr, (cx, cy), r_size + 3, (255, 255, 255), 2)
        sx, sy = scaled[q]
        cv2.putText(img_bgr, f"{q} raw=({cx},{cy})", (cx + r_size + 6, cy - 6),
                    font, scale_f * 0.75, color, max(1, int(scale_f * 2)))
        cv2.putText(img_bgr, f"  scaled=({sx},{sy})", (cx + r_size + 6, cy + int(scale_f * 28)),
                    font, scale_f * 0.65, (200, 200, 0), max(1, int(scale_f * 1.5)))

    # Header info
    q_score = detection["quality_score"]
    header_lines = [
        f"source={source_label}  quality={q_score:.3f}",
        f"orig: {orig_w}x{orig_h} AR={orig_w/orig_h:.4f}",
        f"page: {pw}x{ph}   H-span: {src_h_span:.0f}px → {dst_h_span:.0f}px ({h_scale:.4f}x)",
        f"V-span: {src_v_span:.0f}px → {dst_v_span:.0f}px ({v_scale:.4f}x)   ΔH={delta_aniso:+.1f}%",
    ]
    y0 = int(scale_f * 60)
    for line in header_lines:
        cv2.putText(img_bgr, line, (20, y0), font, scale_f * 0.9, (0, 0, 0), max(3, int(scale_f * 3)))
        cv2.putText(img_bgr, line, (20, y0), font, scale_f * 0.9, (50, 220, 50), max(1, int(scale_f * 2)))
        y0 += int(scale_f * 50)

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = Path(image_path).stem
    out_path = out_dir / f"calibrate_{source_label}_{stem}.jpg"
    cv2.imwrite(str(out_path), img_bgr, [cv2.IMWRITE_JPEG_QUALITY, 88])
    return out_path


# ── Median merge across multiple images ───────────────────────────────────────

def median_centers(detections: list[dict]) -> dict[str, list[int]]:
    """Compute per-quad median of scaled centers across multiple images."""
    quads_x: dict[str, list[float]] = {q: [] for q in QUAD_ORDER}
    quads_y: dict[str, list[float]] = {q: [] for q in QUAD_ORDER}
    for det in detections:
        for q in QUAD_ORDER:
            quads_x[q].append(det["scaled_centers"][q][0])
            quads_y[q].append(det["scaled_centers"][q][1])
    return {
        q: [round(float(np.median(quads_x[q]))), round(float(np.median(quads_y[q])))]
        for q in QUAD_ORDER
    }


# ── Report & comparison ───────────────────────────────────────────────────────

def print_comparison_report(
    new_centers: dict[str, list[int]],
    old_centers: dict[str, list[int]] | None,
    page_dimensions: tuple[int, int],
    source_label: str,
    detections: list[dict],
):
    pw, ph = page_dimensions
    tl_n = np.array(new_centers["TL"], float)
    tr_n = np.array(new_centers["TR"], float)
    br_n = np.array(new_centers["BR"], float)
    bl_n = np.array(new_centers["BL"], float)
    new_h = float(np.linalg.norm(tr_n - tl_n))
    new_v = float(np.linalg.norm(bl_n - tl_n))
    new_ratio = new_h / new_v if new_v > 0 else 0

    print(f"\n{'='*60}")
    print(f"CALIBRATION RESULT for source='{source_label}'")
    print(f"  Images used: {len(detections)}")
    print(f"  pageDimensions: {pw}×{ph}")
    print()
    print(f"  NEW markerCentersInTemplateBySource.{source_label}:")
    for q in QUAD_ORDER:
        cx, cy = new_centers[q]
        print(f"    {q}: [{cx}, {cy}]")
    print(f"  → H-span: {new_h:.0f}px  V-span: {new_v:.0f}px  H/V: {new_ratio:.4f}")

    if old_centers:
        tl_o = np.array(old_centers["TL"], float)
        tr_o = np.array(old_centers["TR"], float)
        br_o = np.array(old_centers["BR"], float)
        bl_o = np.array(old_centers["BL"], float)
        old_h = float(np.linalg.norm(tr_o - tl_o))
        old_v = float(np.linalg.norm(bl_o - tl_o))
        old_ratio = old_h / old_v if old_v > 0 else 0
        print()
        print(f"  OLD markerCentersInTemplate (default / flatbed):")
        for q in QUAD_ORDER:
            cx, cy = old_centers[q]
            print(f"    {q}: [{cx}, {cy}]")
        print(f"  → H-span: {old_h:.0f}px  V-span: {old_v:.0f}px  H/V: {old_ratio:.4f}")

        print()
        print(f"  Diff (new − old):")
        for q in QUAD_ORDER:
            dx = new_centers[q][0] - old_centers[q][0]
            dy = new_centers[q][1] - old_centers[q][1]
            print(f"    {q}: ({dx:+d}, {dy:+d})")

        # Compute per-image H-stretch with OLD vs NEW calibration
        print()
        print(f"  Per-image ΔH-stretch comparison:")
        print(f"  {'Image':<36} {'ΔH old':>8} {'ΔH new':>8}")
        for det in detections:
            raw = det["raw_centers"]
            tl_r = np.array(raw["TL"], float)
            tr_r = np.array(raw["TR"], float)
            bl_r = np.array(raw["BL"], float)
            src_h = float(np.linalg.norm(tr_r - tl_r))
            src_v = float(np.linalg.norm(bl_r - tl_r))
            # Old calibration
            ho = old_h / src_h; vo = old_v / src_v
            delta_old = (ho - vo) * 100
            # New calibration
            hn = new_h / src_h; vn = new_v / src_v
            delta_new = (hn - vn) * 100
            img_name = str(det.get("image_path", "?"))[-34:]
            print(f"  {img_name:<36} {delta_old:>+7.2f}%  {delta_new:>+7.2f}%")

    print()
    print(f"  JSON block to add under cropOnMarkersConfig:")
    print(f'  "markerCentersInTemplateBySource": {{')
    print(f'    "{source_label}": {{')
    for q in QUAD_ORDER:
        cx, cy = new_centers[q]
        comma = "," if q != QUAD_ORDER[-1] else ""
        print(f'      "{q}": [{cx}, {cy}]{comma}')
    print(f'    }}')
    print(f'  }}')
    print(f"{'='*60}\n")


# ── Template write ────────────────────────────────────────────────────────────

def write_to_template(
    template_path: str | Path,
    source_label: str,
    new_centers: dict[str, list[int]],
) -> None:
    """Update template JSON in-place: add/replace markerCentersInTemplateBySource.<source>."""
    p = Path(template_path)
    with open(p, "r", encoding="utf-8") as f:
        data = json.load(f)

    crop_cfg = data.setdefault("cropOnMarkersConfig", {})
    by_source = crop_cfg.setdefault("markerCentersInTemplateBySource", {})
    by_source[source_label] = {q: new_centers[q] for q in QUAD_ORDER}

    with open(p, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"  Written markerCentersInTemplateBySource.{source_label} → {p.name}")


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Calibrate markerCentersInTemplate per image_source",
    )
    parser.add_argument(
        "images",
        nargs="+",
        help="Ảnh cần detect markers (có thể nhiều ảnh, kết quả sẽ lấy median)",
    )
    parser.add_argument(
        "--template",
        nargs="+",
        default=["templates/vju_main_template.calibrated.json"],
        help="Template JSON file(s) để đọc pageDimensions (và optionally ghi --write)",
    )
    parser.add_argument(
        "--source",
        default="scan_app",
        choices=["flatbed", "scan_app", "camera", "auto"],
        help="image_source label (default: scan_app)",
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="Ghi markerCentersInTemplateBySource vào template JSON",
    )
    parser.add_argument(
        "--debug-dir",
        default="outputs/debug_overlays",
        help="Thư mục lưu debug images",
    )
    args = parser.parse_args()

    # Use first template for pageDimensions reference
    ref_template = args.template[0]

    detections: list[dict] = []
    for img_path in args.images:
        print(f"\nDetecting markers: {img_path}")
        det = detect_and_scale(img_path, ref_template)
        if det is None:
            print(f"  SKIP — detection failed")
            continue
        det["image_path"] = img_path
        q = det["quality_score"]
        print(f"  quality={q:.4f}  raw centers: "
              + "  ".join(f"{qd}=({det['raw_centers'][qd][0]:.1f},{det['raw_centers'][qd][1]:.1f})"
                          for qd in QUAD_ORDER))
        print(f"  scaled→pageDims: "
              + "  ".join(f"{qd}=[{det['scaled_centers'][qd][0]},{det['scaled_centers'][qd][1]}]"
                          for qd in QUAD_ORDER))
        # Save debug image
        out = save_debug_image(img_path, det, args.source, args.debug_dir)
        print(f"  debug image → {out}")
        detections.append(det)

    if not detections:
        print("\nERROR: no successful detections. Aborting.", file=sys.stderr)
        sys.exit(1)

    # Compute final centers (median if multiple images)
    if len(detections) == 1:
        final_centers = detections[0]["scaled_centers"]
    else:
        final_centers = median_centers(detections)
        print(f"\nMedian of {len(detections)} images computed.")

    # Load old centers for comparison
    tpl = load_template(ref_template)
    old_centers = tpl.marker_centers_in_template

    for det in detections:
        det["image_path"] = det.get("image_path", "?")

    print_comparison_report(
        final_centers,
        old_centers,
        tpl.page_dimensions,
        args.source,
        detections,
    )

    if args.write:
        print("Writing to template(s)...")
        for tpl_path in args.template:
            write_to_template(tpl_path, args.source, final_centers)
        print("Done.")
    else:
        print("(Dry run — use --write to update template JSON)")


if __name__ == "__main__":
    main()
