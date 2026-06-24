"""
bubble_analyzer.py
==================
Measure fill darkness of bubble ROIs and classify them using the same
global + local threshold algorithm as OMRChecker.

Threshold strategy (mirrors OMRChecker core.py):

  Phase 1 — collect means
    For every bubble on the page:  mean_value = cv2.mean(roi)[0]

  Phase 2 — global threshold (get_global_threshold)
    Sort all mean_values.
    Find the FIRST LARGE GAP in the sorted sequence (sliding window of
    width 2*ls where ls = (looseness+1)//2).
    gap = q_vals[i+ls] - q_vals[i-ls]
    threshold sits at the midpoint of the largest gap:
        thr = q_vals[i-ls] + gap/2
    Fallback if no gap ≥ MIN_JUMP: use GLOBAL_DEFAULT (200 for white paper).

  Phase 3 — local threshold (get_local_threshold, per-strip)
    Sort strip means.
    For strips with ≥ 3 bubbles: find max gap and use its midpoint.
    If strip spread < MIN_GAP or gap < MIN_JUMP: fall back to global_thr.
    For 1-2 bubble strips: fallback to global_thr directly.

  Classification:
    mean_value < local_thr  → MARKED
    mean_value in band      → TOO_LIGHT  (within CONFIDENT_SURPLUS of threshold)
    mean_value ≥ local_thr  → BLANK

  Note: lower mean = darker pixel = more filled.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Sequence

import cv2
import numpy as np

from app.core.templates.template_loader import BubbleSpec


# ── Classification ────────────────────────────────────────────────────────

class BubbleStatus(str, Enum):
    BLANK        = "blank"
    MARKED       = "marked"
    TOO_LIGHT    = "too_light"   # faint mark — near threshold band
    INVALID      = "invalid"     # ROI was empty / corrupt


# ── OMRChecker-style threshold constants ──────────────────────────────────
# Mirrors OMRChecker/src/defaults/config.py threshold_params

MIN_JUMP            = 25    # minimum gap to count as a valid jump
LOOSENESS           = 4     # controls sliding window half-width (ls = (4+1)//2 = 2)
MIN_GAP             = 30    # minimum spread in a strip to attempt local threshold
CONFIDENT_SURPLUS   = 5     # band around threshold → TOO_LIGHT zone
GLOBAL_DEFAULT_THR  = 200   # fallback for white-paper scans (pixels above = blank)

# ── Center-fill (inner circle) constants ─────────────────────────────────
# Printed circle borders create a dark ring around blank bubbles.  Measuring
# only the OUTER inscribed circle (circle_mask) includes this ring and can
# push a blank bubble's mean below the threshold.
#
# The CENTER of a blank bubble stays bright (no ink there).  A genuinely
# filled bubble has dark ink across its whole interior, so its center is
# also dark.  Measuring a smaller INNER circle (60% of inscribed radius)
# distinguishes ring-only false positives from real fills.

CENTER_FILL_INNER_RATIO = 0.60   # inner circle radius = 60 % of inscribed radius
RING_DETECTION_THR      = 0.82   # center_fill > this (i.e. bright center) → ring-only FP

# ── INT-field specific threshold constants ────────────────────────────────
# INT fields (CCCD/SBD/MaDe/…) use a gap algorithm with a lower min_jump
# because the gap between a lightly-filled digit (~190–210) and blank bubbles
# (~220–235) can be as small as 15–20 px — below the MCQ MIN_JUMP of 25.
#
# IMPORTANT — do NOT use a blanket absolute threshold (e.g. "mean < 195"):
# INT bubbles contain PRINTED DIGITS inside them.  The printed ink already
# darkens the mean of a blank bubble.  An absolute cutoff would mark every
# blank bubble as "filled", producing strings like "1234567890…".

INT_MIN_JUMP = 12   # lower than MCQ MIN_JUMP=25; catches 10–12-unit gaps


# ── Data types ────────────────────────────────────────────────────────────

@dataclass
class BubbleReading:
    bubble: BubbleSpec
    mean_value: float       # raw mean pixel value 0–255
    fill_ratio: float       # mean_value / 255.0
    status: BubbleStatus
    local_thr: float        # threshold used for this strip (for diagnostics)
    center_fill: float = 0.0  # inner 60 % circle mean / 255 (0=dark/filled, 1=bright/empty)


# ── Step 1: extract mean values ───────────────────────────────────────────

def measure_roi(
    roi: np.ndarray,
    mean_mode: str = "circle_mask",
) -> float:
    """
    Return mean grayscale pixel value of a bubble ROI.

    Args:
        roi:       Cropped bubble region — img[y:y+h, x:x+w].
        mean_mode: "rect"        — mean over the full rectangle (legacy).
                   "circle_mask" — mean only inside the inscribed circle.
                                   Avoids grid lines and digit strokes at edges.

    Returns:
        float in [0, 255]. Lower = darker = more filled.
    """
    if roi is None or roi.size == 0:
        return 255.0
    gray = roi if len(roi.shape) == 2 else cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)

    if mean_mode == "circle_mask":
        return _measure_circle(gray)
    # fallback: plain rect mean
    return float(cv2.mean(gray)[0])


def _measure_circle(gray: np.ndarray) -> float:
    """Mean intensity inside the largest inscribed circle of a grayscale ROI."""
    h, w = gray.shape[:2]
    r = max(1, min(w, h) // 2)
    cx, cy = w // 2, h // 2

    mask = np.zeros((h, w), dtype=np.uint8)
    cv2.circle(mask, (cx, cy), r, 255, -1)

    # At least 1 pixel must be unmasked
    if cv2.countNonZero(mask) == 0:
        return float(cv2.mean(gray)[0])

    return float(cv2.mean(gray, mask=mask)[0])


def _measure_inner_circle(gray: np.ndarray) -> float:
    """
    Mean intensity inside the *inner* circle (60 % of inscribed radius).

    This smaller mask excludes the printed ring border, so only the true
    centre of the bubble is sampled.  A blank bubble with only a printed
    ring has a bright (high-value) centre; a genuinely filled bubble has
    dark ink throughout and therefore a dark centre too.
    """
    h, w = gray.shape[:2]
    r_full  = max(1, min(w, h) // 2)
    r_inner = max(1, int(r_full * CENTER_FILL_INNER_RATIO))
    cx, cy  = w // 2, h // 2
    mask = np.zeros((h, w), dtype=np.uint8)
    cv2.circle(mask, (cx, cy), r_inner, 255, -1)
    if cv2.countNonZero(mask) == 0:
        return float(cv2.mean(gray)[0])
    return float(cv2.mean(gray, mask=mask)[0])


def measure_roi_with_center(roi: np.ndarray) -> tuple[float, float]:
    """
    Return (outer_mean, inner_mean) for a bubble ROI in one pass.

    outer_mean — mean inside full inscribed circle (same as measure_roi("circle_mask")).
    inner_mean — mean inside inner 60 % circle (avoids the printed ring border).

    Both values are raw pixel intensities in [0, 255].
    Lower = darker = more filled.
    """
    if roi is None or roi.size == 0:
        return 255.0, 255.0
    gray = roi if len(roi.shape) == 2 else cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    outer = _measure_circle(gray)
    inner = _measure_inner_circle(gray)
    return outer, inner


def apply_center_fill_guard(
    readings: list[BubbleReading],
    center_fill_values: list[float],
    ring_thr: float = RING_DETECTION_THR,
) -> list[BubbleReading]:
    """
    Downgrade MARKED → TOO_LIGHT when a bubble's centre is still bright.

    The printed circle border in VJU answer sheets darkens the outer ring.
    A blank bubble can therefore have a mean_value (full inscribed circle)
    close to a real filled bubble, but its *centre* stays bright (no ink).

    Guard logic:
        MARKED  AND  center_fill > ring_thr  →  downgrade to TOO_LIGHT

    Args:
        readings:           Classified readings from classify_strip.
        center_fill_values: Parallel list of (inner_mean / 255) per bubble (0–1).
        ring_thr:           Threshold — centre brighter than this → ring-only FP.

    Returns:
        New list of BubbleReading with MARKED→TOO_LIGHT downgrades applied.
    """
    if not center_fill_values or len(center_fill_values) != len(readings):
        return readings

    result: list[BubbleReading] = []
    for reading, cf in zip(readings, center_fill_values):
        new_status = reading.status
        if reading.status == BubbleStatus.MARKED and cf > ring_thr:
            # Centre is too bright: printed ring only, not a genuine fill
            new_status = BubbleStatus.TOO_LIGHT
        result.append(BubbleReading(
            bubble=reading.bubble,
            mean_value=reading.mean_value,
            fill_ratio=reading.fill_ratio,
            status=new_status,
            local_thr=reading.local_thr,
            center_fill=cf,
        ))
    return result


# ── Step 2: global threshold ──────────────────────────────────────────────

def get_global_threshold(
    all_means: Sequence[float],
    min_jump: float = MIN_JUMP,
    looseness: int = LOOSENESS,
    global_default: float = GLOBAL_DEFAULT_THR,
) -> float:
    """
    Find the FIRST LARGE GAP in sorted mean values.
    Faithful port of OMRChecker ImageInstanceOps.get_global_threshold().

    Returns the threshold value (mean_value < thr → marked).
    """
    if len(all_means) < 3:
        return global_default

    q_vals = sorted(all_means)
    ls = (looseness + 1) // 2    # = 2 for default looseness=4
    n = len(q_vals)
    l = n - ls

    max_gap = min_jump
    thr = global_default

    for i in range(ls, l):
        gap = q_vals[i + ls] - q_vals[i - ls]
        if gap > max_gap:
            max_gap = gap
            thr = q_vals[i - ls] + gap / 2.0

    return thr


# ── Step 3: local threshold per strip ────────────────────────────────────

def get_local_threshold(
    strip_means: Sequence[float],
    global_thr: float,
    min_gap: float = MIN_GAP,
    min_jump: float = MIN_JUMP,
) -> float:
    """
    Per-strip (per field_label) adaptive threshold.
    Mirrors OMRChecker ImageInstanceOps.get_local_threshold().

    Args:
        strip_means: Mean values for all bubbles in one field strip.
        global_thr:  Fallback threshold from get_global_threshold().
        min_gap:     Minimum spread to bother with local threshold.
        min_jump:    Minimum gap to count as valid jump in local strip.

    Returns:
        Local threshold (mean_value < local_thr → marked).
    """
    q_vals = sorted(strip_means)
    n = len(q_vals)

    # Too few points → use global
    if n < 3:
        spread = q_vals[-1] - q_vals[0] if n > 1 else 0
        return global_thr if spread < min_gap else float(np.mean(q_vals))

    # Find the single largest gap in this strip
    best_gap = 0.0
    local_thr = global_thr
    for i in range(1, n):
        gap = q_vals[i] - q_vals[i - 1]
        if gap > best_gap:
            best_gap = gap
            local_thr = (q_vals[i] + q_vals[i - 1]) / 2.0

    # Only use local if gap is meaningful
    if best_gap < min_jump:
        return global_thr

    return local_thr


# ── Step 4: classify strip ────────────────────────────────────────────────

def classify_strip(
    strip_means: list[float],
    bubbles: list[BubbleSpec],
    local_thr: float,
    confident_surplus: float = CONFIDENT_SURPLUS,
) -> list[BubbleReading]:
    """
    Classify each bubble in a strip using the computed local threshold.

    mean_value < local_thr - surplus  → MARKED
    mean_value < local_thr + surplus  → TOO_LIGHT (ambiguous band)
    mean_value ≥ local_thr + surplus  → BLANK
    """
    readings: list[BubbleReading] = []
    lo = local_thr - confident_surplus
    hi = local_thr + confident_surplus

    for mean_val, bubble in zip(strip_means, bubbles):
        fill = mean_val / 255.0

        if mean_val < lo:
            status = BubbleStatus.MARKED
        elif mean_val < hi:
            status = BubbleStatus.TOO_LIGHT
        else:
            status = BubbleStatus.BLANK

        readings.append(BubbleReading(
            bubble=bubble,
            mean_value=mean_val,
            fill_ratio=fill,
            status=status,
            local_thr=local_thr,
        ))

    return readings


# ── Convenience: analyze a single bubble with given thresholds ────────────

def analyze_bubble(
    roi: np.ndarray,
    bubble: BubbleSpec,
    local_thr: float = GLOBAL_DEFAULT_THR,
    confident_surplus: float = CONFIDENT_SURPLUS,
) -> BubbleReading:
    """Analyze a single bubble ROI given a pre-computed threshold."""
    mean_val = measure_roi(roi)
    fill = mean_val / 255.0
    lo = local_thr - confident_surplus
    hi = local_thr + confident_surplus

    if roi is None or (hasattr(roi, 'size') and roi.size == 0):
        return BubbleReading(bubble=bubble, mean_value=255.0, fill_ratio=1.0,
                             status=BubbleStatus.INVALID, local_thr=local_thr)

    if mean_val < lo:
        status = BubbleStatus.MARKED
    elif mean_val < hi:
        status = BubbleStatus.TOO_LIGHT
    else:
        status = BubbleStatus.BLANK

    return BubbleReading(bubble=bubble, mean_value=mean_val, fill_ratio=fill,
                         status=status, local_thr=local_thr)


# ── INT-field adaptive classifier ────────────────────────────────────────

def classify_strip_int(
    strip_means: list[float],
    bubbles: list[BubbleSpec],
    global_thr: float,
    confident_surplus: float = CONFIDENT_SURPLUS,
) -> list[BubbleReading]:
    """
    INT digit-column classifier.

    Strategy
    --------
    INT bubbles contain printed digits — the ink from "1"…"0" already darkens
    the mean of a BLANK bubble.  Therefore we must NOT use a blanket absolute
    threshold such as "mean < 195 → marked", which would fire on every blank
    bubble and produce strings like "1234567890…".

    Instead we use the same gap-based algorithm as MCQ, with two relaxations:

    1. **Lower min_jump** (INT_MIN_JUMP=12 vs MCQ's 25).
       A lightly-filled digit may produce a gap of only 15–20 between the
       filled bubble and the blank ones.  The strict MCQ threshold would fall
       back to global_thr and miss the mark; the lower threshold catches it.

    2. **Single-outlier fallback**.
       If the gap algorithm still falls back to global_thr (gap < INT_MIN_JUMP
       even with the lower threshold), we check whether the darkest bubble
       is clearly separated from the second-darkest:
         - gap(darkest, 2nd-darkest) ≥ INT_MIN_JUMP  → use their midpoint.
       This catches the case where one bubble is a clear outlier but the gap
       to its nearest neighbour is just below INT_MIN_JUMP.

    No absolute threshold.  No blanket relative threshold.
    Both relaxations are column-relative and data-driven.

    Args:
        strip_means:       Mean pixel values for each bubble in the column.
        bubbles:           Corresponding BubbleSpec list (same order).
        global_thr:        Global threshold from get_global_threshold().
        confident_surplus: Half-width of the TOO_LIGHT ambiguity band (±px).

    Returns:
        List of BubbleReading.  May contain 0, 1, or (rarely) 2 MARKED entries.
    """
    if not strip_means:
        return []

    # ── Step 1: gap algorithm with INT_MIN_JUMP ───────────────────────────
    eff_thr = get_local_threshold(
        strip_means, global_thr, min_jump=INT_MIN_JUMP,
    )

    # ── Step 2: single-outlier fallback ──────────────────────────────────
    # Only kicks in when step 1 fell back to global_thr (no gap ≥ INT_MIN_JUMP).
    if eff_thr == global_thr and len(strip_means) >= 2:
        sorted_m = sorted(strip_means)
        top2_gap = sorted_m[1] - sorted_m[0]  # gap between darkest and 2nd-darkest
        if top2_gap >= INT_MIN_JUMP:
            # One bubble is a clear outlier: threshold at the midpoint.
            eff_thr = (sorted_m[0] + sorted_m[1]) / 2.0

    lo = eff_thr - confident_surplus
    hi = eff_thr + confident_surplus

    readings: list[BubbleReading] = []
    for mean_val, bubble in zip(strip_means, bubbles):
        fill = mean_val / 255.0

        if mean_val < lo:
            status = BubbleStatus.MARKED
        elif mean_val < hi:
            status = BubbleStatus.TOO_LIGHT
        else:
            status = BubbleStatus.BLANK

        readings.append(BubbleReading(
            bubble=bubble,
            mean_value=mean_val,
            fill_ratio=fill,
            status=status,
            local_thr=eff_thr,
        ))

    return readings


# ── Legacy: analyze_field_strip (used by unit tests + old engine path) ────

def analyze_field_strip(
    rois: list[np.ndarray],
    bubbles: list[BubbleSpec],
    global_thr: float | None = None,
    mean_mode: str = "circle_mask",
) -> list[BubbleReading]:
    """
    Analyze a field strip using local threshold computed from strip means.
    global_thr is used as fallback; if None, uses GLOBAL_DEFAULT_THR.
    mean_mode: "rect" or "circle_mask" (default).
    """
    fallback = global_thr if global_thr is not None else GLOBAL_DEFAULT_THR
    strip_means = [measure_roi(roi, mean_mode=mean_mode) for roi in rois]
    local_thr = get_local_threshold(strip_means, fallback)
    return classify_strip(strip_means, bubbles, local_thr)
