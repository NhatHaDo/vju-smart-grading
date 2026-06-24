"""
crop_on_markers.py
==================
Detect 4 corner registration markers on a VJU answer sheet and perform a
perspective warp to align it to template pageDimensions.

VJU answer sheets have 4 small solid black squares near each corner.
This module uses contour-based blob detection (no reference image needed).

Algorithm
---------
1. CLAHE + Gaussian blur → enhance contrast for camera photos
2. Multi-strategy thresholding (Otsu → Adaptive → Fixed 100) until 4 markers found
3. Morphological close to fill tiny gaps in printed markers
4. findContours → filter by area / solidity / aspect-ratio / corner-zone
5. Assign to quadrant (TL/TR/BL/BR) and pick best per quadrant
6. Validate: area consistency across 4 markers
7. Compute marker_quality_score and decide whether to apply warp (quality gate)
8. If template marker positions known AND quality OK:
     4-point getPerspectiveTransform → warpPerspective (correct mode)
   Else if quality too low:
     skip warp, return original image with warp_candidate_image for debug
   Else (no template positions):
     four_point_transform (legacy mode)

Root-cause notes (camera photos)
---------------------------------
* Simple global threshold misses markers in dark/bright corners.
* Loose solidity/aspect filters pick desk shadows (sol≈0.73, asp≈0.57).
* Real VJU markers have sol≥0.92, asp ≈1.0.
* The "closest to corner" strategy picks wrong blobs when a large shadow
  sits between the image edge and the actual marker.
* Fix: CLAHE + tighter solidity (0.82) + corner-zone constraint ensures
  only true markers (solid, square, in the outer 5-35% of each corner) pass.
* Even when 4 markers are detected, the quality gate validates that the
  detected quadrilateral is geometrically sound before applying warp.
  This prevents a "nearly-straight" image from being distorted by a noisy warp.

Priority in engine:  CropOnMarkers → CropPage → no-crop
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import cv2
import numpy as np

from app.core.omr.preprocessor import four_point_transform, order_points

logger = logging.getLogger(__name__)


# ── Marker detection parameters ───────────────────────────────────────────

# Area as fraction of total image area
MARKER_MIN_AREA_FRAC = 0.00008   # ~0.008% — catches very small markers
MARKER_MAX_AREA_FRAC = 0.012     # 1.2% — reject large content blobs

# Solidity: area / convex_hull_area.  Real VJU markers = 0.96-1.00.
# Allow down to 0.82 for printed sheets with slight ink imperfections.
MARKER_MIN_SOLIDITY = 0.82

# Aspect ratio w/h — markers are roughly square (allow minor perspective skew)
MARKER_MIN_ASPECT = 0.50
MARKER_MAX_ASPECT = 2.00

# Minimum inset from image edge (fraction of width/height).
# Markers are ON the paper, not at the very pixel boundary.
MARKER_MIN_EDGE_FRAC = 0.005     # must be > 0.5% from image edge

# Maximum inset from the RELEVANT corner (fraction of image).
# Markers are in the outer ~35% of each axis from the corner side.
MARKER_MAX_ZONE_FRAC = 0.38

# Maximum area ratio between largest and smallest chosen marker.
# Real markers printed at the same physical size should be ±30% in area.
MARKER_MAX_AREA_RATIO = 6.0

# ── Quality gate ──────────────────────────────────────────────────────────
# Minimum quality score (0–1) to apply warp.  Below this the detected markers
# are considered unreliable and the original image is returned instead.
# This prevents a "nearly-straight" original from being warped to something worse.
WARP_QUALITY_MIN_SCORE = 0.45

# Relaxed fallback params (used when tight params find < 4 valid markers)
_RELAX_STAGES = [
    # (min_solidity, min_aspect, max_aspect, min_area_frac, max_area_frac, max_zone)
    (0.82, 0.50, 2.00, 0.00008, 0.012, 0.38),  # Stage 0: tight (default)
    (0.75, 0.40, 2.50, 0.00006, 0.015, 0.42),  # Stage 1: slightly relaxed
    (0.65, 0.30, 3.50, 0.00005, 0.020, 0.48),  # Stage 2: OMRChecker-like
    (0.50, 0.20, 5.00, 0.00005, 0.020, 0.55),  # Stage 3: legacy/permissive
]


# ── Data classes ──────────────────────────────────────────────────────────

@dataclass
class MarkerResult:
    """Result of crop_on_markers()."""
    image:                 np.ndarray           # final image: warped if warp_used, else original
    success:               bool                 # True if ≥4 markers detected
    reason:                str                  # "ok" | "warp_rejected" | "no_valid_markers"
    original_size:         tuple[int, int]      # (w, h)
    marker_pts:            np.ndarray | None    # shape (4, 2) float32 — TL, TR, BR, BL
    target_size:           tuple[int, int] | None
    prep_stage:            int = -1             # which _RELAX_STAGE succeeded
    marker_centers:        list[dict] | None = None  # [{quad, cx, cy, area, solidity}]
    homography:            np.ndarray | None = None  # 3×3 matrix used (or computed but not applied)
    # ── Quality gate ──────────────────────────────────────────────────────
    marker_quality_score:  float = 0.0          # 0–1; higher = more reliable markers
    warp_used:             bool = False          # True = warp was applied after passing quality gate
    warp_rejected_reason:  str | None = None    # human-readable reason if warp was rejected
    warp_candidate_image:  np.ndarray | None = None  # the computed warp (for debug even if rejected)
    # ── Per-source calibration debug fields ───────────────────────────────
    marker_centers_source_used: str | None = None           # "scan_app" | "flatbed" | "default"
    destination_marker_centers_used: dict[str, list[int]] | None = None  # actual dst_pts used
    estimated_h_stretch: float | None = None    # estimated horizontal stretch ratio vs vertical


# ── Public API ────────────────────────────────────────────────────────────

def crop_on_markers(
    image: np.ndarray,
    target_size: tuple[int, int] | None = None,
    debug: bool = False,
    marker_centers_in_template: dict[str, tuple[int, int]] | None = None,
    min_warp_quality: float = WARP_QUALITY_MIN_SCORE,
) -> MarkerResult:
    """
    Detect 4 corner markers and (if quality gate passes) warp the sheet to target_size.

    Args:
        image:       Grayscale (preferred) or BGR image.
        target_size: (width, height) to warp to — should be pageDimensions.
                     If None, warp to natural rectangle.
        debug:       Log per-candidate detail.
        marker_centers_in_template:
                     {"TL":[cx,cy], "TR":..., "BL":..., "BR":...} positions
                     of marker centers in the target template coordinate space.
                     When provided the warp is a proper homography that maps
                     marker centers exactly to these positions, filling the
                     full target_size canvas.  This is the correct mode for
                     templates calibrated with CropPage coordinates.
        min_warp_quality:
                     Override the quality gate threshold (default WARP_QUALITY_MIN_SCORE=0.45).
                     Higher = more conservative (reject more warps).
                     Lower = more aggressive (apply warp even with noisy markers).
                     Use image_source to drive this: flatbed=0.65, scan_app=0.60,
                     camera=0.35, auto=0.45.

    Returns:
        MarkerResult with .success, .image, .warp_used, .marker_quality_score.
        If warp is rejected (.warp_used=False), .image is the original grayscale
        and .warp_candidate_image holds the computed (but rejected) warp output.
    """
    gray = image if len(image.shape) == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    orig_h, orig_w = gray.shape[:2]
    original_size = (orig_w, orig_h)

    logger.debug(f"CropOnMarkers: original size = {orig_w}×{orig_h}")

    # ── Pre-process: CLAHE → GaussianBlur ────────────────────────────────
    # CLAHE normalises uneven illumination (camera photos with shadows).
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    blurred  = cv2.GaussianBlur(enhanced, (5, 5), 0)

    # ── Multi-strategy thresholding ───────────────────────────────────────
    # Try Otsu → Adaptive → Fixed-100.  Each produces a binary mask of dark blobs.
    binary_candidates: list[np.ndarray] = []

    # 1. Otsu on CLAHE-enhanced image (best for camera)
    _, otsu = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    binary_candidates.append(otsu)

    # 2. Adaptive Gaussian (good when background is uneven)
    adapt = cv2.adaptiveThreshold(
        blurred, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV,
        blockSize=51, C=10,
    )
    binary_candidates.append(adapt)

    # 3. Fixed global threshold (legacy, reliable for scanned sheets)
    norm = cv2.normalize(blurred, None, 0, 255, cv2.NORM_MINMAX)
    _, fixed = cv2.threshold(norm, 100, 255, cv2.THRESH_BINARY_INV)
    binary_candidates.append(fixed)

    # Morphology kernel for closing small gaps
    close_k = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))

    # ── Try each binary × each relaxation stage until 4 markers found ────
    for stage_idx, (min_sol, min_asp, max_asp, min_af, max_af, max_zone) in enumerate(_RELAX_STAGES):
        for bin_idx, raw_binary in enumerate(binary_candidates):
            binary = cv2.morphologyEx(raw_binary, cv2.MORPH_CLOSE, close_k, iterations=2)

            chosen, src_pts, marker_info = _detect_markers(
                binary, orig_w, orig_h,
                min_sol=min_sol, min_asp=min_asp, max_asp=max_asp,
                min_area_frac=min_af, max_area_frac=max_af,
                max_zone=max_zone,
                debug=(debug and stage_idx == 0 and bin_idx == 0),
            )

            if chosen is not None:
                logger.info(
                    f"CropOnMarkers: found markers at stage={stage_idx} "
                    f"binary={['otsu','adaptive','fixed'][bin_idx]}"
                )
                return _do_warp(
                    gray, chosen, src_pts, marker_info,
                    target_size, marker_centers_in_template,
                    original_size, stage_idx,
                    min_warp_quality=min_warp_quality,
                )

    # All strategies exhausted
    logger.debug("CropOnMarkers: could not find 4 valid markers in any strategy pass")
    return MarkerResult(
        image=gray, success=False,
        reason="no_valid_markers",
        original_size=original_size, marker_pts=None, target_size=target_size,
    )


# ── Marker quality scoring ─────────────────────────────────────────────────

def _compute_marker_quality(
    chosen: dict,
    src_pts: np.ndarray,
    stage_idx: int,
    area_ratio: float,
) -> tuple[float, str | None]:
    """
    Score the reliability of the 4 detected markers.

    Returns:
        (quality_score 0–1, hard_reject_reason or None)
        A score < WARP_QUALITY_MIN_SCORE or a non-None reject_reason triggers warp rejection.

    Scoring components:
        parallelism  (0.35): top/bottom widths and left/right heights should match
        solidity     (0.25): high solidity = solid square blobs = reliable markers
        area_uniformity (0.20): all 4 markers should have similar areas
        stage        (0.10): stage 0 (tightest filters) = most reliable
        diagonal     (0.10): midpoints of diagonals should coincide (parallelogram)
    """
    tl = src_pts[0].astype(float)
    tr = src_pts[1].astype(float)
    br = src_pts[2].astype(float)
    bl = src_pts[3].astype(float)

    # 1. Parallelism
    top_w   = float(np.linalg.norm(tr - tl))
    bot_w   = float(np.linalg.norm(br - bl))
    left_h  = float(np.linalg.norm(bl - tl))
    right_h = float(np.linalg.norm(br - tr))

    w_ratio    = min(top_w, bot_w) / max(top_w, bot_w, 1.0)
    h_ratio    = min(left_h, right_h) / max(left_h, right_h, 1.0)
    para_score = (w_ratio + h_ratio) / 2.0

    # 2. Solidity
    solidities  = [chosen[q]["solidity"] for q in ("TL", "TR", "BL", "BR")]
    avg_sol     = sum(solidities) / 4.0
    sol_score   = max(0.0, min(1.0, (avg_sol - 0.50) / 0.50))

    # 3. Area uniformity  (area_ratio 1.0 → perfect; 6.0 → limit)
    area_score  = max(0.0, 1.0 - (area_ratio - 1.0) / 5.0)

    # 4. Stage quality (0 = tightest; 3 = loosest)
    stage_score = max(0.0, 1.0 - stage_idx * 0.25)

    # 5. Diagonal midpoint convergence (parallelogram check)
    mid1       = (tl + br) / 2.0
    mid2       = (tr + bl) / 2.0
    diag_off   = float(np.linalg.norm(mid1 - mid2))
    img_diag   = float(np.linalg.norm(br - tl)) + 1.0
    diag_score = max(0.0, 1.0 - diag_off / (img_diag * 0.15))

    quality = (
        0.35 * para_score
        + 0.25 * sol_score
        + 0.20 * area_score
        + 0.10 * stage_score
        + 0.10 * diag_score
    )

    # Hard reject conditions (geometry too bad regardless of score)
    reject_reason: str | None = None
    if para_score < 0.40:
        reject_reason = f"quad_too_skewed (para={para_score:.2f})"
    elif avg_sol < 0.55:
        reject_reason = f"low_avg_solidity ({avg_sol:.2f})"
    elif area_ratio > 5.0:
        reject_reason = f"area_inconsistent (ratio={area_ratio:.1f}x)"

    logger.debug(
        f"  quality_score={quality:.3f}  "
        f"para={para_score:.2f} sol={sol_score:.2f} area={area_score:.2f} "
        f"stage={stage_score:.2f} diag={diag_score:.2f}  "
        f"hard_reject={reject_reason}"
    )
    return round(quality, 3), reject_reason


# ── Marker detection core ─────────────────────────────────────────────────

def _detect_markers(
    binary: np.ndarray,
    orig_w: int, orig_h: int,
    *,
    min_sol: float, min_asp: float, max_asp: float,
    min_area_frac: float, max_area_frac: float,
    max_zone: float,
    debug: bool,
) -> tuple[dict | None, np.ndarray | None, list[dict] | None]:
    """
    Find 4 corner markers in a binary (white-on-black) mask.

    Returns:
        (chosen_dict, src_pts_array, marker_info_list) or (None, None, None)
    """
    img_area = orig_w * orig_h
    min_area = min_area_frac * img_area
    max_area = max_area_frac * img_area

    # Corner-zone boundaries (markers must be in the outer portion of the image)
    min_edge_x = MARKER_MIN_EDGE_FRAC * orig_w
    min_edge_y = MARKER_MIN_EDGE_FRAC * orig_h
    max_zone_x = max_zone * orig_w
    max_zone_y = max_zone * orig_h

    cnts, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    candidates: list[dict] = []
    for c in cnts:
        area = cv2.contourArea(c)
        if area < min_area or area > max_area:
            continue

        hull = cv2.convexHull(c)
        hull_area = cv2.contourArea(hull)
        if hull_area < 1:
            continue
        solidity = area / hull_area
        if solidity < min_sol:
            continue

        x, y, w, h = cv2.boundingRect(c)
        aspect = w / max(h, 1)
        if not (min_asp <= aspect <= max_asp):
            continue

        cx, cy = x + w / 2, y + h / 2

        # Corner-zone check: must be in the outer zone for at least one corner
        in_left   = (min_edge_x < cx < max_zone_x)
        in_right  = (orig_w - max_zone_x < cx < orig_w - min_edge_x)
        in_top    = (min_edge_y < cy < max_zone_y)
        in_bottom = (orig_h - max_zone_y < cy < orig_h - min_edge_y)

        in_corner = (
            (in_left and in_top)    or  # TL zone
            (in_right and in_top)   or  # TR zone
            (in_left and in_bottom) or  # BL zone
            (in_right and in_bottom)    # BR zone
        )
        if not in_corner:
            continue

        candidates.append({
            "cx": cx, "cy": cy,
            "area": area, "solidity": solidity, "aspect": aspect,
            "x": x, "y": y, "w": w, "h": h,
        })

    if debug:
        logger.debug(f"  _detect_markers: {len(candidates)} corner-zone candidates "
                     f"(area {min_area:.0f}-{max_area:.0f}, sol≥{min_sol}, asp {min_asp}-{max_asp})")
        for cand in sorted(candidates, key=lambda c: c["area"], reverse=True)[:8]:
            logger.debug(f"    ({cand['cx']:.0f},{cand['cy']:.0f}) "
                         f"area={cand['area']:.0f} sol={cand['solidity']:.2f} asp={cand['aspect']:.2f}")

    if len(candidates) < 4:
        return None, None, None

    # ── Assign to quadrants ───────────────────────────────────────────────
    mid_x, mid_y = orig_w / 2, orig_h / 2

    quads: dict[str, list[dict]] = {"TL": [], "TR": [], "BL": [], "BR": []}
    for cand in candidates:
        cx, cy = cand["cx"], cand["cy"]
        if cx < mid_x and cy < mid_y:      quads["TL"].append(cand)
        elif cx >= mid_x and cy < mid_y:   quads["TR"].append(cand)
        elif cx < mid_x and cy >= mid_y:   quads["BL"].append(cand)
        else:                               quads["BR"].append(cand)

    # Pick closest-to-corner in each quadrant
    corner_targets = {
        "TL": (0,       0),
        "TR": (orig_w,  0),
        "BL": (0,       orig_h),
        "BR": (orig_w,  orig_h),
    }
    chosen: dict[str, dict | None] = {}
    for quad, corner in corner_targets.items():
        blobs = quads[quad]
        if not blobs:
            chosen[quad] = None
            continue
        chosen[quad] = min(
            blobs,
            key=lambda b: (b["cx"] - corner[0]) ** 2 + (b["cy"] - corner[1]) ** 2,
        )

    missing = [q for q, b in chosen.items() if b is None]
    if missing:
        logger.debug(f"  _detect_markers: missing quadrant(s): {missing}")
        return None, None, None

    # ── Area consistency check ────────────────────────────────────────────
    areas = [chosen[q]["area"] for q in ("TL", "TR", "BL", "BR")]
    area_ratio = max(areas) / max(min(areas), 1)
    if area_ratio > MARKER_MAX_AREA_RATIO:
        if debug:
            logger.debug(f"  _detect_markers: area ratio {area_ratio:.1f}x > {MARKER_MAX_AREA_RATIO} → reject")
        return None, None, None

    # ── Build src points TL, TR, BR, BL ──────────────────────────────────
    src_pts = np.array([
        [chosen["TL"]["cx"], chosen["TL"]["cy"]],
        [chosen["TR"]["cx"], chosen["TR"]["cy"]],
        [chosen["BR"]["cx"], chosen["BR"]["cy"]],
        [chosen["BL"]["cx"], chosen["BL"]["cy"]],
    ], dtype="float32")

    marker_info = [
        {"quad": q, "cx": chosen[q]["cx"], "cy": chosen[q]["cy"],
         "area": chosen[q]["area"], "solidity": chosen[q]["solidity"]}
        for q in ("TL", "TR", "BR", "BL")
    ]

    if debug:
        logger.debug(f"  _detect_markers: area_ratio={area_ratio:.1f}x ✓ — chosen: "
                     + ", ".join(f"{q}=({chosen[q]['cx']:.0f},{chosen[q]['cy']:.0f})"
                                  for q in ("TL","TR","BL","BR")))
    return chosen, src_pts, marker_info


# ── Perspective warp ──────────────────────────────────────────────────────

def _do_warp(
    gray: np.ndarray,
    chosen: dict,
    src_pts: np.ndarray,
    marker_info: list[dict],
    target_size: tuple[int, int] | None,
    marker_centers_in_template: dict | None,
    original_size: tuple[int, int],
    stage_idx: int,
    *,
    min_warp_quality: float = WARP_QUALITY_MIN_SCORE,
) -> MarkerResult:
    """
    Compute perspective warp from detected markers.
    Quality gate: if markers are unreliable, return original image + warp_candidate_image.

    Args:
        min_warp_quality: threshold from image_source strategy (flatbed=0.65,
                          scan_app=0.60, camera=0.35, auto=0.45).
    """
    # Area ratio (recomputed from marker_info for quality scoring)
    areas = [m["area"] for m in marker_info]
    area_ratio = max(areas) / max(min(areas), 1.0)

    # ── Quality gate ──────────────────────────────────────────────────────
    quality_score, hard_reject = _compute_marker_quality(chosen, src_pts, stage_idx, area_ratio)
    logger.info(
        f"CropOnMarkers: quality_score={quality_score:.3f}  "
        f"min_warp_quality={min_warp_quality:.2f}  "
        f"hard_reject={hard_reject or 'none'}  stage={stage_idx}"
    )

    # ── Always compute warp (for aligned_candidate_path debug) ───────────
    M: np.ndarray | None = None
    warp_candidate: np.ndarray | None = None

    try:
        if marker_centers_in_template is not None and target_size is not None:
            # Correct mode: homography → exact template coordinate alignment
            dst_pts = np.array([
                marker_centers_in_template["TL"],
                marker_centers_in_template["TR"],
                marker_centers_in_template["BR"],
                marker_centers_in_template["BL"],
            ], dtype="float32")
            M = cv2.getPerspectiveTransform(src_pts, dst_pts)
            tw, th = target_size
            warp_candidate = cv2.warpPerspective(
                gray, M, (tw, th),
                flags=cv2.INTER_CUBIC,
                borderMode=cv2.BORDER_REPLICATE,
            )
        else:
            # Legacy mode: map marker centers to page corners + resize
            warp_candidate = four_point_transform(gray, src_pts, target_size=target_size)
    except Exception as exc:
        logger.warning(f"CropOnMarkers: warp computation failed — {exc}")
        warp_candidate = None
        if hard_reject is None:
            hard_reject = f"warp_compute_error: {exc}"

    # ── Decide: use warp or return original ───────────────────────────────
    should_warp = (hard_reject is None) and (quality_score >= min_warp_quality)

    if should_warp and warp_candidate is not None:
        warp_h, warp_w = warp_candidate.shape[:2]
        logger.info(
            f"CropOnMarkers: warp applied ✓ → {warp_w}×{warp_h}  "
            f"({'correct' if marker_centers_in_template else 'legacy'} mode)"
        )
        return MarkerResult(
            image=warp_candidate,
            success=True,
            reason="ok",
            original_size=original_size,
            marker_pts=src_pts,
            target_size=(warp_w, warp_h),
            prep_stage=stage_idx,
            marker_centers=marker_info,
            homography=M,
            marker_quality_score=quality_score,
            warp_used=True,
            warp_rejected_reason=None,
            warp_candidate_image=None,   # not needed; final image IS the warp
        )
    else:
        # Warp rejected — return original image but keep candidate for debug
        final_reason = hard_reject or f"quality_score_too_low ({quality_score:.2f} < {min_warp_quality:.2f})"
        logger.info(f"CropOnMarkers: warp REJECTED → {final_reason}")
        return MarkerResult(
            image=gray,
            success=True,
            reason="warp_rejected",
            original_size=original_size,
            marker_pts=src_pts,
            target_size=target_size,
            prep_stage=stage_idx,
            marker_centers=marker_info,
            homography=M,
            marker_quality_score=quality_score,
            warp_used=False,
            warp_rejected_reason=final_reason,
            warp_candidate_image=warp_candidate,  # save for aligned_candidate_path
        )


# ── Rectified visual image (keep aspect ratio) ───────────────────────────

def create_visual_rectified_keep_aspect(
    image: np.ndarray,
    src_pts: np.ndarray,
    margin: int = 30,
) -> tuple[np.ndarray, int, int]:
    """
    Warp the image to a flat top-down view while preserving the sheet's true aspect ratio.

    Unlike warpPerspective to pageDimensions (which can introduce anisotropic stretch),
    this function:
      1. Measures the actual marker-to-marker distances (TL→TR, BL→BR, TL→BL, TR→BR).
      2. Computes output width/height from the average of the two parallel sides.
      3. Warps only using those natural dimensions + a small margin — no template coords.

    Args:
        image:   Grayscale or BGR image.
        src_pts: (4,2) float32 array — TL, TR, BR, BL in that order.
        margin:  White-space padding in pixels added on each side (default 30).

    Returns:
        (warped_canvas, out_w, out_h)
        warped_canvas — the flat perspective-corrected image
        out_w, out_h  — its pixel dimensions (including margin)

    Raises:
        ValueError if src_pts shape is wrong.
        cv2.error on warp failure (caller should catch).
    """
    if src_pts.shape != (4, 2):
        raise ValueError(f"src_pts must be (4,2), got {src_pts.shape}")

    tl = src_pts[0].astype(float)
    tr = src_pts[1].astype(float)
    br = src_pts[2].astype(float)
    bl = src_pts[3].astype(float)

    # Average of the two horizontal sides and two vertical sides
    w_top  = float(np.linalg.norm(tr - tl))
    w_bot  = float(np.linalg.norm(br - bl))
    h_left = float(np.linalg.norm(bl - tl))
    h_right= float(np.linalg.norm(br - tr))

    natural_w = max(1.0, (w_top + w_bot) / 2.0)
    natural_h = max(1.0, (h_left + h_right) / 2.0)

    out_w = int(round(natural_w)) + 2 * margin
    out_h = int(round(natural_h)) + 2 * margin

    dst_pts = np.array([
        [margin,             margin            ],   # TL
        [margin + natural_w, margin            ],   # TR
        [margin + natural_w, margin + natural_h],   # BR
        [margin,             margin + natural_h],   # BL
    ], dtype="float32")

    M = cv2.getPerspectiveTransform(src_pts.astype("float32"), dst_pts)

    gray = image if len(image.shape) == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    canvas = cv2.warpPerspective(
        gray, M, (out_w, out_h),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=255,
    )

    return canvas, out_w, out_h


# ── Marker debug visualiser ───────────────────────────────────────────────

def draw_markers_debug(
    image: np.ndarray,
    result: MarkerResult,
    include_labels: bool = True,
) -> np.ndarray:
    """
    Draw detected marker positions on the original image with labels.
    Shows quality score and warp decision.

    Returns a BGR image (same size as input).
    """
    gray = image if len(image.shape) == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    vis = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    h, w = vis.shape[:2]
    FONT = cv2.FONT_HERSHEY_SIMPLEX

    # Quadrant dividers
    cv2.line(vis, (w // 2, 0), (w // 2, h), (180, 180, 0), 2)
    cv2.line(vis, (0, h // 2), (w, h // 2), (180, 180, 0), 2)

    if not result.success or result.marker_pts is None:
        msg = f"FAILED: {result.reason}"
        (mw, mh), _ = cv2.getTextSize(msg, FONT, 1.0, 2)
        cv2.putText(vis, msg, ((w - mw) // 2, h // 2), FONT, 1.0, (0, 0, 220), 2)
        return vis

    quad_colors = {
        "TL": (0,   255,  0),    # green
        "TR": (0,   128, 255),   # orange
        "BR": (0,   0,   255),   # red
        "BL": (255, 0,   255),   # magenta
    }
    labels = ["TL", "TR", "BR", "BL"]

    scale  = min(w, h) / 1000.0  # font scale relative to image size
    r_size = max(15, int(min(w, h) * 0.012))

    for pt, lbl in zip(result.marker_pts, labels):
        x, y = int(pt[0]), int(pt[1])
        color = quad_colors.get(lbl, (255, 255, 255))
        cv2.circle(vis, (x, y), r_size, color, -1)
        cv2.circle(vis, (x, y), r_size + 2, (255, 255, 255), 2)

        if include_labels:
            minfo = ""
            if result.marker_centers:
                for mi in result.marker_centers:
                    if mi["quad"] == lbl:
                        minfo = f"a={int(mi['area'])} s={mi['solidity']:.2f}"
                        break
            cv2.putText(vis, lbl, (x + r_size + 4, y),
                        FONT, scale * 0.9, color, max(1, int(scale * 2)))
            if minfo:
                cv2.putText(vis, minfo, (x + r_size + 4, y + int(scale * 22)),
                            FONT, scale * 0.6, (255, 255, 255), 1)

    # Connect with polygon
    pts_poly = np.array([
        [int(result.marker_pts[0][0]), int(result.marker_pts[0][1])],  # TL
        [int(result.marker_pts[1][0]), int(result.marker_pts[1][1])],  # TR
        [int(result.marker_pts[2][0]), int(result.marker_pts[2][1])],  # BR
        [int(result.marker_pts[3][0]), int(result.marker_pts[3][1])],  # BL
    ], dtype=np.int32)
    cv2.polylines(vis, [pts_poly], isClosed=True, color=(0, 220, 255), thickness=2)

    # Status banner — green if warp applied, orange if rejected
    stage_str = f"stage={result.prep_stage}" if result.prep_stage >= 0 else ""
    q_str = f"q={result.marker_quality_score:.2f}"
    if result.warp_used:
        warp_str = "WARP ✓"
        banner_color = (0, 220, 100)
    else:
        warp_str = f"WARP ✗ ({result.warp_rejected_reason or 'rejected'})"
        banner_color = (0, 140, 255)

    banner = f"{stage_str} {q_str} {warp_str}".strip()
    cv2.putText(vis, banner, (10, 40), FONT, scale * 0.9, banner_color, max(2, int(scale * 2.5)))

    return vis


# ── Comprehensive debug (for scripts/tests) ────────────────────────────────

@dataclass
class CandidateInfo:
    idx: int; x: int; y: int; w: int; h: int
    area: float; hull_area: float; solidity: float; aspect: float
    cx: float; cy: float; quadrant: str
    accepted: bool; reject_reasons: list = field(default_factory=list)


@dataclass
class MarkerDebugResult:
    candidates:   list        # CandidateInfo — all contours evaluated
    accepted:     list        # CandidateInfo — passed all filters
    chosen:       dict        # str → CandidateInfo|None per quadrant
    warp_result:  MarkerResult
    binary_image: object      # np.ndarray
    img_w:        int
    img_h:        int


def debug_crop_on_markers(
    image,
    target_size=None,
    min_area_frac=0.00008,
    max_area_frac=0.020,
    min_solidity=0.65,
    min_aspect=0.30,
    max_aspect=3.50,
    binary_thr=100,
):
    """
    Run marker detection with exhaustive per-contour logging.
    Parameters are slightly relaxed to catch marginal markers.
    Returns MarkerDebugResult.
    """
    gray = image if len(image.shape) == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    orig_h, orig_w = gray.shape[:2]
    img_area = orig_h * orig_w

    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    blurred  = cv2.GaussianBlur(enhanced, (5, 5), 0)
    _, binary = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary_closed = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, k, iterations=2)

    cnts, _ = cv2.findContours(binary_closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    min_area = min_area_frac * img_area
    max_area = max_area_frac * img_area
    mid_x, mid_y = orig_w / 2, orig_h / 2

    def quad(cx, cy):
        if cx < mid_x and cy < mid_y:   return "TL"
        if cx >= mid_x and cy < mid_y:  return "TR"
        if cx < mid_x and cy >= mid_y:  return "BL"
        return "BR"

    all_cands: list[CandidateInfo] = []
    accepted:  list[CandidateInfo] = []

    for idx, c in enumerate(cnts):
        area = cv2.contourArea(c)
        x, y, w, h = cv2.boundingRect(c)
        cx, cy = x + w / 2, y + h / 2
        q = quad(cx, cy)
        hull = cv2.convexHull(c)
        hull_area = cv2.contourArea(hull)
        solidity = area / hull_area if hull_area > 0 else 0.0
        aspect = w / max(h, 1)

        reasons = []
        if area < min_area:      reasons.append(f"area_small({area:.0f}<{min_area:.0f})")
        if area > max_area:      reasons.append(f"area_large({area:.0f}>{max_area:.0f})")
        if solidity < min_solidity: reasons.append(f"sol({solidity:.3f}<{min_solidity})")
        if aspect < min_aspect:  reasons.append(f"asp_narrow({aspect:.2f}<{min_aspect})")
        if aspect > max_aspect:  reasons.append(f"asp_wide({aspect:.2f}>{max_aspect})")

        ci = CandidateInfo(
            idx=idx, x=x, y=y, w=w, h=h,
            area=area, hull_area=hull_area, solidity=solidity, aspect=aspect,
            cx=cx, cy=cy, quadrant=q,
            accepted=(len(reasons) == 0), reject_reasons=reasons,
        )
        all_cands.append(ci)
        if ci.accepted:
            accepted.append(ci)

    corner_targets = {
        "TL": (0,      0),
        "TR": (orig_w, 0),
        "BL": (0,      orig_h),
        "BR": (orig_w, orig_h),
    }
    chosen: dict[str, CandidateInfo | None] = {}
    for q, corner in corner_targets.items():
        in_q = [c for c in accepted if c.quadrant == q]
        chosen[q] = (
            min(in_q, key=lambda b: (b.cx - corner[0])**2 + (b.cy - corner[1])**2)
            if in_q else None
        )

    warp = crop_on_markers(image, target_size=target_size, debug=True)

    return MarkerDebugResult(
        candidates=all_cands,
        accepted=accepted,
        chosen=chosen,
        warp_result=warp,
        binary_image=binary_closed,
        img_w=orig_w,
        img_h=orig_h,
    )


def draw_candidates_image(image, dbg: MarkerDebugResult) -> np.ndarray:
    """All contours: GREEN=accepted, RED=rejected, CYAN=chosen."""
    gray = image if len(image.shape) == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    vis = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    h, w = vis.shape[:2]
    FONT = cv2.FONT_HERSHEY_SIMPLEX

    cv2.line(vis, (w // 2, 0), (w // 2, h), (200, 200, 0), 2)
    cv2.line(vis, (0, h // 2), (w, h // 2), (200, 200, 0), 2)

    chosen_idx = {c.idx for c in dbg.chosen.values() if c is not None}

    for c in dbg.candidates:
        if c.accepted:
            color = (0, 220, 255) if c.idx in chosen_idx else (0, 200, 0)
            thick = 4 if c.idx in chosen_idx else 2
        else:
            color, thick = (0, 0, 200), 1
        cv2.rectangle(vis, (c.x, c.y), (c.x + c.w, c.y + c.h), color, thick)
        cv2.putText(vis, str(c.idx), (c.x, max(12, c.y - 4)), FONT, 0.45, (255, 255, 255), 1)

    for ql, ci in dbg.chosen.items():
        if ci is None: continue
        cv2.putText(vis, f"[{ql}]", (ci.x, max(12, ci.y - 20)), FONT, 0.8, (0, 220, 255), 2)

    return vis


def draw_selected_image(image, dbg: MarkerDebugResult) -> np.ndarray:
    """Draw only the 4 chosen markers with labels and connecting polygon."""
    gray = image if len(image.shape) == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    vis = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    FONT = cv2.FONT_HERSHEY_SIMPLEX
    quad_colors = {"TL": (0,255,0), "TR": (0,128,255), "BR": (0,0,255), "BL": (255,0,255)}

    pts_poly = []
    for ql in ("TL", "TR", "BR", "BL"):
        ci = dbg.chosen.get(ql)
        if ci is None: continue
        color = quad_colors[ql]
        cv2.rectangle(vis, (ci.x, ci.y), (ci.x+ci.w, ci.y+ci.h), color, 3)
        cv2.circle(vis, (int(ci.cx), int(ci.cy)), 10, color, -1)
        cv2.putText(vis, f"{ql}", (ci.x, max(14, ci.y-10)), FONT, 0.9, color, 2)
        cv2.putText(vis,
            f"a={int(ci.area)} sol={ci.solidity:.2f}",
            (ci.x, ci.y + ci.h + 18), FONT, 0.5, color, 1)
        pts_poly.append((int(ci.cx), int(ci.cy)))

    if len(pts_poly) == 4:
        poly = np.array(pts_poly, dtype=np.int32)
        cv2.polylines(vis, [poly], isClosed=True, color=(0, 220, 255), thickness=2)

    return vis
