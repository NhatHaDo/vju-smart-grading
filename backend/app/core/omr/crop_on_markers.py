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

# Maximum allowed relative deviation between the detected marker quad's
# width/height ratio and the EXPECTED ratio (derived from
# marker_centers_in_template, when provided) before rejecting the pick and
# retrying with the next binary/relaxation stage.
#
# 2026-08-05: found via a 34-photo real-world batch test (AET2015 sheets,
# same physical layout as the QM2025 template) — 4/34 photos produced a
# quad that passed EVERY existing check (para_score 0.93-0.99, solidity,
# area-consistency, diagonal-midpoint) yet had aspect 0.575-1.02 instead of
# the template's true 0.71 (up to a 43% relative miss). None of the existing
# checks catch this: they all validate INTERNAL self-consistency of the 4
# points (is it a parallelogram? do diagonals bisect?) but never compare the
# resulting shape's overall proportions against what the physical page is
# known to look like. A clean, well-formed parallelogram of the WRONG size
# is exactly what you get when detection locks onto 4 self-consistent but
# non-marker blobs (e.g. all 4 corners of an interior content box) instead
# of the true corner markers — the existing checks are structurally blind to
# this failure mode. Genuine photos (even skewed/rotated ones — a proper
# homography corrects for that) stayed within 0.3% of the true aspect across
# all 30 unaffected photos in the same batch, so 6% leaves a wide margin
# above real variation while still catching the smallest observed miss
# (8.6%).
MARKER_MAX_ASPECT_DEVIATION = 0.06

# 2026-08-06: looser tolerance used when expected_aspect came from
# page_aspect_fallback (the template's raw page W/H) instead of precise
# marker-center calibration. Real corner markers aren't printed exactly on
# the page edge, so the marker-QUAD aspect ratio can differ from the raw
# PAGE aspect ratio by a small, template-dependent, but not zero, margin —
# unlike the 0.3%-across-30-photos precision quoted above for calibrated
# templates. Set well above that possible offset plus ordinary handheld
# keystone, but still far below the -30%/+23%/-30% deviations actually
# observed on the 3 real "Utokyo" misdetections this constant was added to
# catch (see page_aspect_fallback docstring in crop_on_markers()).
MARKER_MAX_ASPECT_DEVIATION_FALLBACK = 0.18

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
    page_aspect_fallback: float | None = None,
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
        page_aspect_fallback:
                     width/height of the template's page — used as the
                     expected marker-quad aspect ratio (see the "Aspect-ratio
                     plausibility check" below) whenever
                     marker_centers_in_template isn't available ("legacy"
                     warp mode). 2026-08-06: that check already existed and
                     already catches exactly this failure — a well-formed
                     but WRONG quad (e.g. a sheet's internal Phần I/II/III/IV
                     section-divider squares picked instead of the true
                     corners) — but it was silently a no-op for any template
                     without explicit marker-center calibration, since
                     expected_aspect had no other source. The page rectangle
                     itself is a perfectly good (if slightly less precise)
                     stand-in: real corner markers are printed close to the
                     page edges, so the marker-quad AR should track the page
                     AR to within a few percent on a correctly-cropped photo
                     — confirmed on 3 real "Utokyo" template photos that were
                     stretching content into the wrong shape: observed quad
                     AR was off by -30%, +23%, -30% vs the page's 0.707,
                     miles past MARKER_MAX_ASPECT_DEVIATION=0.06.

    Returns:
        MarkerResult with .success, .image, .warp_used, .marker_quality_score.
        If warp is rejected (.warp_used=False), .image is the original grayscale
        and .warp_candidate_image holds the computed (but rejected) warp output.
    """
    gray = image if len(image.shape) == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    orig_h, orig_w = gray.shape[:2]
    original_size = (orig_w, orig_h)

    logger.debug(f"CropOnMarkers: original size = {orig_w}×{orig_h}")

    # Expected marker-quad aspect ratio. Prefer the precise value derived
    # from the template's own declared marker positions ("correct mode");
    # fall back to the page's own aspect ratio when that calibration isn't
    # available — see page_aspect_fallback docstring above.
    expected_aspect: float | None = None
    if marker_centers_in_template is not None:
        try:
            ew = float(marker_centers_in_template["TR"][0]) - float(marker_centers_in_template["TL"][0])
            eh = float(marker_centers_in_template["BL"][1]) - float(marker_centers_in_template["TL"][1])
            if ew > 0 and eh > 0:
                expected_aspect = ew / eh
        except (KeyError, IndexError, TypeError, ZeroDivisionError):
            expected_aspect = None
    expected_aspect_is_fallback = False
    if expected_aspect is None and page_aspect_fallback is not None and page_aspect_fallback > 0:
        expected_aspect = page_aspect_fallback
        expected_aspect_is_fallback = True

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

    # 2026-08-04: pre-compute ALL 3 morphed binaries once, up front — the
    # outlier-quadrant refinement (see _refine_worst_quadrant) needs to be
    # able to search EVERY binary strategy for the flagged quadrant, not just
    # whichever one happened to be "current" when 4 markers first turned up.
    # Confirmed real case: the true TL corner was cleanly isolated (sol=0.95,
    # asp=1.00) under "adaptive" thresholding, but under "otsu" it was fused
    # into one large blob with an adjacent printed border line (sol=0.61,
    # asp=3.30 — nothing like a marker) — invisible to a refinement that only
    # ever looks at the single binary the outer loop is currently trying.
    morphed_binaries = [
        cv2.morphologyEx(b, cv2.MORPH_CLOSE, close_k, iterations=2)
        for b in binary_candidates
    ]

    # ── Try each binary × each relaxation stage until 4 markers found ────
    for stage_idx, (min_sol, min_asp, max_asp, min_af, max_af, max_zone) in enumerate(_RELAX_STAGES):
        for bin_idx, binary in enumerate(morphed_binaries):
            chosen, src_pts, marker_info = _detect_markers(
                binary, orig_w, orig_h,
                min_sol=min_sol, min_asp=min_asp, max_asp=max_asp,
                min_area_frac=min_af, max_area_frac=max_af,
                max_zone=max_zone,
                stage_idx=stage_idx,
                all_binaries=morphed_binaries,
                expected_aspect=expected_aspect,
                expected_aspect_is_fallback=expected_aspect_is_fallback,
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


# ── Outlier-quadrant refinement (see call site in _detect_markers) ────────

REFINE_TRIGGER_PCT      = 3.0   # only attempt refinement above this diag offset %
# 2026-08-06: was 5.0 — lowered after a real case (z8093749410429) measured
# 4.6% diag offset from a single wrong TL corner (a decoy square from a
# folded/dog-eared paper corner) and silently sailed under the old trigger,
# never even attempting a search. See _refine_worst_quadrant's 2026-08-06
# note for the full story (also fixed a bug there: refinement used to only
# search the single quadrant a flawed heuristic guessed was "worst", which
# on this exact photo picked the WRONG quadrant to fix). REFINE_MIN_IMPROVEMENT
# and REFINE_MAX_ACCEPT_PCT below are what actually keep this safe — a lower
# trigger just means refinement is ATTEMPTED more often, not that swaps are
# accepted more easily.
REFINE_MIN_IMPROVEMENT  = 0.60  # candidate's new offset must be <= this fraction of current
REFINE_MAX_ACCEPT_PCT   = 8.0   # candidate's new offset must also land below this absolute bar
# 2026-08-04: matches the stricter of the two area-ratio hard-reject cutoffs
# already enforced downstream (_compute_marker_quality's own hard_reject at
# 5.0x, tighter than _detect_markers' post-hoc MARKER_MAX_AREA_RATIO=6.0) —
# confirmed real case: multi-binary search found a candidate with a nearly
# perfect diag offset (2.7%) but a much SMALLER area than the other 3
# markers (a partial/fragment blob, not the full printed square), which
# passed the diag-offset bar but then tripped the downstream area-ratio hard
# reject, rejecting the ENTIRE warp — worse than leaving the original
# (imperfect but area-consistent) pick alone. Refinement must reject such
# candidates itself instead of letting a later stage silently throw away the
# whole detection.
REFINE_MAX_AREA_RATIO   = 5.0

# Absolute ceiling on post-swap aspect-ratio deviation from expected_aspect
# (see the 2026-08-06 guard in _refine_worst_quadrant). Looser than the
# module-level MARKER_MAX_ASPECT_DEVIATION_FALLBACK=0.18 hard-reject — this
# only needs to stop refinement from CONFIDENTLY installing a swap that's
# still clearly wrong; the hard-reject downstream is the last line of
# defense if refinement can't find anything under this bar.
REFINE_MAX_ACCEPT_ASPECT_DEV = 0.08


def _diag_offset_pct(chosen: dict) -> float:
    """% of the TL-BR diagonal length by which the TL-BR and TR-BL diagonal
    midpoints fail to coincide — 0% for a perfect parallelogram, larger for
    an increasingly non-rectangular quad. See _refine_worst_quadrant."""
    tl, tr, bl, br = chosen["TL"], chosen["TR"], chosen["BL"], chosen["BR"]
    mid1 = ((tl["cx"] + br["cx"]) / 2.0, (tl["cy"] + br["cy"]) / 2.0)
    mid2 = ((tr["cx"] + bl["cx"]) / 2.0, (tr["cy"] + bl["cy"]) / 2.0)
    off = ((mid1[0] - mid2[0]) ** 2 + (mid1[1] - mid2[1]) ** 2) ** 0.5
    length = (((br["cx"] - tl["cx"]) ** 2 + (br["cy"] - tl["cy"]) ** 2) ** 0.5) + 1.0
    return off / length * 100.0


REFINE_MAX_ROUNDS = 2   # re-check for a NEW worst quadrant after each swap


def _quad_observed_aspect(chosen: dict) -> float:
    """Same aggregate top/bottom-width ÷ left/right-height formula as the
    module-level aspect-ratio plausibility check — kept separate so
    _refine_worst_quadrant can evaluate it per-candidate without needing the
    4 numpy points assembled yet."""
    tl, tr, bl, br = chosen["TL"], chosen["TR"], chosen["BL"], chosen["BR"]
    top_w   = ((tr["cx"] - tl["cx"]) ** 2 + (tr["cy"] - tl["cy"]) ** 2) ** 0.5
    bot_w   = ((br["cx"] - bl["cx"]) ** 2 + (br["cy"] - bl["cy"]) ** 2) ** 0.5
    left_h  = ((bl["cx"] - tl["cx"]) ** 2 + (bl["cy"] - tl["cy"]) ** 2) ** 0.5
    right_h = ((br["cx"] - tr["cx"]) ** 2 + (br["cy"] - tr["cy"]) ** 2) ** 0.5
    return ((top_w + bot_w) / 2.0) / max((left_h + right_h) / 2.0, 1.0)


def _refine_worst_quadrant(
    chosen: dict,
    binaries: list[np.ndarray],
    orig_w: int, orig_h: int,
    stage_idx: int,
    debug: bool,
    expected_aspect: float | None = None,
) -> dict:
    """Try to fix the single most-inconsistent corner by cross-checking
    against the other 3 (see the long comment at the call site for the real
    case this was written for). No-op unless the current quad already looks
    suspicious AND a decisively better alternate exists.

    2026-08-04: originally only re-scanned the ONE binary (otsu/adaptive/
    fixed) that the outer loop happened to be trying when 4 markers first
    turned up — but a marker can be perfectly clean under one binary
    strategy while fused into an unrelated blob under another. Confirmed
    real case: true TL marker was fused with an adjacent printed border
    line under otsu (sol=0.61, asp=3.30 — nothing marker-like) but cleanly
    isolated under adaptive (sol=0.95, asp=1.00, 5px from the true corner).
    The outer loop never even TRIES adaptive for this photo because otsu
    already returned *a* 4-corner result (just a wrong one) — so refinement
    must search every binary itself. Also loops up to REFINE_MAX_ROUNDS
    times: fixing the worst quadrant can reveal that a different one is now
    the new worst (each swap only ever touches one quadrant at a time).

    2026-08-06: which quadrant is "worst" used to be picked BEFORE searching
    for alternates, via distance from the chosen point to the raw image
    corner (0,0)/(w,0)/etc. That heuristic conflates "far from the image
    edge" with "wrong" — but a correctly-detected marker can sit far from
    the raw image corner for a completely innocent reason (extra background/
    table margin in the photo framing), while a genuinely wrong point can
    still be close to its image corner. Confirmed on a real photo
    (z8093749410429): TL had locked onto a decoy square (another sheet's
    marker peeking out from under a folded/dog-eared corner) instead of the
    true TL marker sitting 116px away — but the pre-search heuristic flagged
    TR as "worst" instead (TR's raw distance to (w,0) was, by coincidence of
    this photo's framing, slightly larger than TL's distance to (0,0)),
    wasted its one swap moving TR from a correct position to a WRONG one,
    and left the actually-broken TL untouched — diag offset numerically
    improved (4.6%→0.8%) while the quad got LESS correct.
    The leave-one-out parallelogram defect (expected_X via the other 3) is
    mathematically identical in magnitude for all 4 corners when only one is
    wrong — it cannot tell you which corner to blame either. The only way to
    find out is to try candidates in EVERY quadrant and see which single
    swap actually explains away the defect: on the same photo, swapping in
    the true alternate TL candidate reduced the offset to 0.25% — a clearly
    better resolution than the wrong TR swap's 0.81%. So: evaluate the best
    available candidate in ALL 4 quadrants each round (not just one
    heuristically-guessed quadrant), and commit to whichever single swap
    yields the lowest resulting offset."""
    corner_targets = {"TL": (0, 0), "TR": (orig_w, 0), "BL": (0, orig_h), "BR": (orig_w, orig_h)}
    img_area = orig_w * orig_h
    min_edge_x = MARKER_MIN_EDGE_FRAC * orig_w
    min_edge_y = MARKER_MIN_EDGE_FRAC * orig_h

    def best_candidate_for_quadrant(quad: str, current_pct: float) -> tuple[dict | None, float]:
        """Search every binary × every relaxation tier (from stage_idx
        onward) for the alternate candidate in `quad` that most reduces the
        overall diagonal offset. Returns (candidate_or_None, resulting_pct)."""
        best_cand: dict | None = None
        best_pct = current_pct
        for tier_idx in range(stage_idx, len(_RELAX_STAGES)):
            min_sol, min_asp, max_asp, min_af, max_af, max_zone = _RELAX_STAGES[tier_idx]
            min_area = min_af * img_area
            max_area = max_af * img_area
            max_zone_x = max_zone * orig_w
            max_zone_y = max_zone * orig_h

            for binary in binaries:
                cnts, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
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

                    in_left   = min_edge_x < cx < max_zone_x
                    in_right  = orig_w - max_zone_x < cx < orig_w - min_edge_x
                    in_top    = min_edge_y < cy < max_zone_y
                    in_bottom = orig_h - max_zone_y < cy < orig_h - min_edge_y
                    in_quad_zone = {
                        "TL": in_left and in_top, "TR": in_right and in_top,
                        "BL": in_left and in_bottom, "BR": in_right and in_bottom,
                    }[quad]
                    if not in_quad_zone:
                        continue

                    # A candidate that fits the diagonal geometry well but is
                    # a fragment/partial blob (much smaller area than the
                    # other 3 already-trusted markers) would trip the
                    # downstream area-consistency hard-reject and throw away
                    # the WHOLE detection — worse than not refining at all.
                    other_areas = [chosen[q]["area"] for q in chosen if q != quad]
                    trial_areas = other_areas + [area]
                    area_ratio = max(trial_areas) / max(min(trial_areas), 1.0)
                    if area_ratio > REFINE_MAX_AREA_RATIO:
                        continue

                    trial = dict(chosen)
                    trial[quad] = {"cx": cx, "cy": cy}
                    pct = _diag_offset_pct(trial)
                    if pct < best_pct:
                        best_pct = pct
                        best_cand = {"cx": cx, "cy": cy, "area": area, "solidity": solidity, "aspect": aspect}
        return best_cand, best_pct

    for _round in range(REFINE_MAX_ROUNDS):
        current_pct = _diag_offset_pct(chosen)
        if current_pct <= REFINE_TRIGGER_PCT:
            break  # already coherent — nothing left to refine

        # Try all 4 quadrants, keep whichever single swap wins outright.
        best_quad: str | None = None
        best_cand: dict | None = None
        best_pct = current_pct
        for quad in corner_targets:
            cand, pct = best_candidate_for_quadrant(quad, current_pct)
            if cand is not None and pct < best_pct:
                best_pct = pct
                best_cand = cand
                best_quad = quad

        if not (
            best_cand is not None
            and best_pct <= current_pct * REFINE_MIN_IMPROVEMENT
            and best_pct <= REFINE_MAX_ACCEPT_PCT
        ):
            break  # no decisive improvement found this round — stop

        # 2026-08-06: diagonal-bisection offset alone isn't sufficient —
        # confirmed on a real photo (z8093749637297) where TL was ALREADY
        # correctly detected (x≈91, matching the true corner), but the
        # search still found an alternate TL candidate (x≈238, actually an
        # internal decorative marker) that made the quad's diagonals bisect
        # *more* precisely (6.6%→0.2%) purely by coincidence — every photo
        # has some genuine keystone, so the true (correctly-detected) quad
        # is never a perfect parallelogram, leaving room for a wrong-but-
        # more-symmetric alternate to look "better" by this metric alone.
        # That swap silently made a fine detection much worse (AR deviation
        # from the page's known aspect ratio went from ~1% to 17%). Guard:
        # when expected_aspect is available, require the swap to also not
        # make the AR deviation worse — a swap that "fixes" the diagonals
        # while moving further from the known page shape is exactly the
        # coincidence above, not a genuine correction.
        if expected_aspect is not None and expected_aspect > 0:
            aspect_dev_before = abs(_quad_observed_aspect(chosen) / expected_aspect - 1.0)
            trial = dict(chosen)
            trial[best_quad] = best_cand
            aspect_dev_after = abs(_quad_observed_aspect(trial) / expected_aspect - 1.0)
            # Relative check alone isn't enough: if the PRE-swap quad already
            # has a bad aspect deviation (e.g. because it came from a binary/
            # stage path that itself isn't great), "doesn't get much worse"
            # can still leave a badly-wrong quad standing. Also require the
            # POST-swap deviation to land under an absolute ceiling —
            # REFINE_MAX_ACCEPT_ASPECT_DEV — mirroring the existing relative-
            # AND-absolute pattern already used for the diagonal-offset check
            # (REFINE_MIN_IMPROVEMENT + REFINE_MAX_ACCEPT_PCT above).
            if (
                aspect_dev_after > aspect_dev_before + 0.02
                or aspect_dev_after > REFINE_MAX_ACCEPT_ASPECT_DEV
            ):
                if debug:
                    logger.debug(
                        f"  _refine_worst_quadrant round {_round}: rejected {best_quad} swap — "
                        f"diag offset improved ({current_pct:.1f}%->{best_pct:.1f}%) but aspect "
                        f"deviation worsened ({aspect_dev_before*100:.0f}%->{aspect_dev_after*100:.0f}%)"
                    )
                break

        if debug:
            logger.debug(
                f"  _refine_worst_quadrant round {_round}: {best_quad} "
                f"{current_pct:.1f}% -> {best_pct:.1f}% via alt candidate "
                f"at ({best_cand['cx']:.0f},{best_cand['cy']:.0f})"
            )
        chosen = dict(chosen)
        chosen[best_quad] = best_cand

    return chosen


# ── Marker detection core ─────────────────────────────────────────────────

def _detect_markers(
    binary: np.ndarray,
    orig_w: int, orig_h: int,
    *,
    min_sol: float, min_asp: float, max_asp: float,
    min_area_frac: float, max_area_frac: float,
    max_zone: float,
    stage_idx: int = 0,
    all_binaries: list[np.ndarray] | None = None,
    expected_aspect: float | None = None,
    expected_aspect_is_fallback: bool = False,
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

    # Pick the best marker-like candidate in each quadrant.
    #
    # NOTE: previously this picked purely by distance-to-corner, which fails
    # when a non-marker blob (paper edge sliver, shadow, fold line — often
    # elongated/non-square after morphological closing) happens to sit closer
    # to the raw image corner than the real printed marker. Real VJU markers
    # are printed squares (aspect ≈ 1.0, solidity ≈ 0.92-1.00); a real test
    # photo (2026-07-28) showed a thin sliver at dist≈198px beating the real
    # marker at dist≈264px purely on proximity, despite being clearly
    # non-square (aspect=0.51 vs the real marker's 1.00) — this produced a
    # visibly wrong warp (grid landed in the blank page margin).
    #
    # A first fix ranked candidates by "how marker-like" they are via a hard
    # boolean bucket (squareness_dev > 0.25) before ever consulting distance.
    # That bucket is too coarse: a sheet whose printed design has EXTRA small
    # black-square markers away from the true corners (used as section
    # dividers between "Phần I/II/III", e.g. photo "mẫu khác2.jpg",
    # 2026-07-28) can have a decorative square that is JUST as square/solid
    # as the true corner marker — both land in the same bucket, so the tie is
    # broken by solidity alone (near-random noise) and distance is *never*
    # actually consulted, even though the decorative square can be 5-10x
    # farther from the true corner. That produced a wildly wrong warp
    # (aligned image showed a rotated crop of the sheet's middle section).
    #
    # Fix: replace the hard bucket with a continuous weighted score —
    # squareness (30%) + solidity (30%) + normalized distance-to-corner
    # (40%). This keeps real shadows/slivers (large squareness/solidity gap)
    # from winning on proximity alone (the original bug), while now giving
    # distance real weight to break ties between two similarly well-formed
    # squares — correctly preferring the true corner over a decorative
    # internal marker of the same size/quality. Verified against all 7
    # photos in the regression corpus at fix time: zero change for the 6
    # that already aligned correctly, and the 7th now locks onto the true
    # corners (quality score 0.82 → 0.98) instead of the internal markers.
    corner_targets = {
        "TL": (0,       0),
        "TR": (orig_w,  0),
        "BL": (0,       orig_h),
        "BR": (orig_w,  orig_h),
    }
    diag = (orig_w ** 2 + orig_h ** 2) ** 0.5
    chosen: dict[str, dict | None] = {}
    for quad, corner in corner_targets.items():
        blobs = quads[quad]
        if not blobs:
            chosen[quad] = None
            continue

        def _score(b: dict, corner=corner) -> float:
            squareness_dev = abs(b["aspect"] - 1.0)
            dist = ((b["cx"] - corner[0]) ** 2 + (b["cy"] - corner[1]) ** 2) ** 0.5
            norm_dist = dist / diag
            return squareness_dev * 0.30 + (1 - b["solidity"]) * 0.30 + norm_dist * 0.40

        chosen[quad] = min(blobs, key=_score)

    missing = [q for q, b in chosen.items() if b is None]
    if missing:
        logger.debug(f"  _detect_markers: missing quadrant(s): {missing}")
        return None, None, None

    # ── Outlier-quadrant refinement ───────────────────────────────────────
    # 2026-08-04: the per-quadrant `_score` above picks INDEPENDENTLY per
    # quadrant — it has no way to notice that its pick for ONE quadrant makes
    # the overall 4-point quad an obvious non-rectangle, even when the other
    # 3 quadrants clearly agree with each other. Confirmed on 3 separate real
    # camera photos of the same custom template ("Utokyo" — has extra small
    # black-square SECTION-DIVIDER markers at internal Phần I/II/III/IV
    # boundaries, printed in the outer 38% corner zone by coincidence of this
    # template's layout): the true corner marker was slightly under-detected
    # (blur/shadow shaved a few points off its solidity, occasionally below
    # this stage's min_sol cutoff entirely) so a section-divider square won
    # its quadrant on local score alone — producing a visibly skewed
    # trapezoid. One confirmed case: TL landed ~460px from the true corner,
    # diagonal-bisection offset 10.3% of the diagonal — under the existing
    # 15% hard-reject cutoff below, so the bad warp was silently applied.
    #
    # Fix: if the resulting quad's diagonal offset is already large enough to
    # be suspicious (>5%, chosen well below the 15% hard-reject line so this
    # only touches genuinely borderline cases), re-scan ONLY the single
    # worst-agreeing quadrant using the NEXT relaxation tier's looser
    # thresholds, and swap in whichever alternate candidate makes the 4-point
    # quad most self-consistent (minimises diagonal-bisection offset) — never
    # picked by local squareness/solidity/distance alone, but cross-checked
    # against the other 3 markers, which independently agreeing with each
    # other is itself strong evidence they're already correct. Only accepts
    # the swap if it is a decisive improvement (cuts the offset by ≥40% AND
    # lands at ≤8%, comfortably inside the range of normally-good photos) —
    # otherwise leaves the original per-quadrant picks untouched entirely, so
    # already-coherent detections (the vast majority — median offset across
    # 69 unique archived camera photos is 0.34%) are never touched by this.
    # Verified on the 992234f27e734e339a1bd7b9c13a3e4e case: TL offset
    # 10.3% → 3.95%, swapping (388,432) [wrong] for (124,430) [the true
    # corner marker's own position].
    chosen = _refine_worst_quadrant(
        chosen, all_binaries or [binary], orig_w, orig_h, stage_idx, debug,
        expected_aspect=expected_aspect,
    )

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

    # ── Diagonal-midpoint plausibility check ──────────────────────────────
    # For a true rectangular sheet, diagonals TL-BR and TR-BL should bisect
    # each other at (roughly) the same point regardless of perspective/
    # rotation — a parallelogram property. If one quadrant's "best" scoring
    # candidate is actually an internal decorative marker (e.g. a Phần
    # section-divider square) rather than the true corner, this happens
    # when the true corner wasn't even detected as a contour in this
    # threshold pass (confirmed on a real phone photo 2026-07-29: the BL
    # corner was missing entirely under Otsu — likely a shadow/contrast
    # issue in that region — so the section-divider square near image
    # centre won the BL bucket by elimination). The other 3 corners,
    # solidity, and area-consistency checks all look individually fine, so
    # nothing else here catches it — but the resulting quad's diagonals
    # miss each other badly (this exact case: ~15.5% of the diagonal
    # length, versus a clean photo's usual low single digits). This mirrors
    # the "diagonal" component already scored in _compute_marker_quality
    # (same 15% cutoff — that component hits 0 exactly here), but as a
    # hard reject at the point of candidate SELECTION rather than only a
    # score penalty: rejecting here lets crop_on_markers' outer loop retry
    # with the next threshold strategy (adaptive/fixed) or relaxation
    # stage, which may actually find the true corner — whereas failing
    # later in the quality gate only leads to "give up, use the original
    # unwarped image" for this attempt, without ever trying to do better.
    tl_pt = np.array([chosen["TL"]["cx"], chosen["TL"]["cy"]])
    tr_pt = np.array([chosen["TR"]["cx"], chosen["TR"]["cy"]])
    br_pt = np.array([chosen["BR"]["cx"], chosen["BR"]["cy"]])
    bl_pt = np.array([chosen["BL"]["cx"], chosen["BL"]["cy"]])
    diag_mid1 = (tl_pt + br_pt) / 2.0
    diag_mid2 = (tr_pt + bl_pt) / 2.0
    diag_off  = float(np.linalg.norm(diag_mid1 - diag_mid2))
    diag_len  = float(np.linalg.norm(br_pt - tl_pt)) + 1.0
    if diag_off > diag_len * 0.15:
        if debug:
            logger.debug(
                f"  _detect_markers: diagonal mismatch (off={diag_off:.0f}px, "
                f"{diag_off / diag_len * 100:.0f}% of diagonal) → reject, retry next strategy"
            )
        return None, None, None

    # ── Aspect-ratio plausibility check ────────────────────────────────────
    # See MARKER_MAX_ASPECT_DEVIATION above for the real-world case this
    # catches: a quad can be a clean, internally-consistent parallelogram
    # (passes parallelism, solidity, area-consistency, AND diagonal-midpoint
    # above) while still being the WRONG shape entirely — e.g. all 4 points
    # actually landed on an interior content box instead of the true corner
    # markers. Comparing against the page's own known aspect ratio (from the
    # template's declared marker positions) is the only check that catches
    # this, because it is the only one that looks outside the 4 points
    # themselves.
    if expected_aspect is not None and expected_aspect > 0:
        top_w   = float(np.linalg.norm(tr_pt - tl_pt))
        bot_w   = float(np.linalg.norm(br_pt - bl_pt))
        left_h  = float(np.linalg.norm(bl_pt - tl_pt))
        right_h = float(np.linalg.norm(br_pt - tr_pt))
        observed_aspect = ((top_w + bot_w) / 2.0) / max((left_h + right_h) / 2.0, 1.0)
        aspect_dev = abs(observed_aspect / expected_aspect - 1.0)
        aspect_limit = (
            MARKER_MAX_ASPECT_DEVIATION_FALLBACK if expected_aspect_is_fallback
            else MARKER_MAX_ASPECT_DEVIATION
        )
        if aspect_dev > aspect_limit:
            if debug:
                logger.debug(
                    f"  _detect_markers: aspect mismatch (observed={observed_aspect:.3f} "
                    f"expected={expected_aspect:.3f}, dev={aspect_dev * 100:.0f}%, "
                    f"limit={aspect_limit*100:.0f}%{' [fallback]' if expected_aspect_is_fallback else ''}) "
                    f"→ reject, retry next strategy"
                )
            return None, None, None

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
