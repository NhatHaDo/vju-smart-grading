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

# 2026-07-28: relaxed retry floor for get_global_threshold() when the strict
# MIN_JUMP=25 search finds no qualifying gap. See that function's docstring.
#
# 2026-07-29: floor=10 still missed several real photos from the same batch —
# their windowed marked/blank gap (ls=2 sliding window) measured 6.0-8.2,
# just under 10. Confirmed on 4 separate uploads (1.jpg/3.jpg/4.jpg/5.jpg,
# gaps 8.6/7.6/6.5/8.9 respectively) that each has a genuine, stable
# separation (re-running the search at floor 5, 4, 3, 2, 1 all found the
# EXACT SAME threshold — no jitter/noise — confirming these are real
# population gaps, not an artifact of relaxing too far). Without this, a
# composite field's single-bubble sub-fields (sign "-", decimal-position),
# which have no local strip to fall back on (n=1, see get_local_threshold's
# n==1 note), trusted the hardcoded GLOBAL_DEFAULT_THR=200 fallback and
# misread every genuinely blank "-"/decimal-position bubble as MARKED.
# Lowered to 5 (comfortable margin below the smallest confirmed real gap
# of 6.5).
GLOBAL_RELAXED_MIN_JUMP = 5

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

# Tight-cluster fallback for INT columns (see classify_strip_int step 2).
# 2026-07-28: "Mã sinh viên" (m_sv) columns on real scans showed gaps of
# 9.9-11.2 — just under INT_MIN_JUMP=12 — with the other 9 (blank) digit
# bubbles clustered within 1.6-5.5 of each other. Visually these are clean
# single-digit marks, but classify_strip_int()'s single fallback path
# (top2_gap >= INT_MIN_JUMP) rejected them, falling back to the lenient
# global default and marking all 10 digits as filled ("over_detect").
# Mirrors the MCQ_OUTLIER_TIGHT_* fix in get_local_threshold(): a lower
# floor is accepted when the non-darkest bubbles are unusually uniform.
#
# 2026-07-28 (template "temp3"): m_sv7 (gap 7.2) and m_sv8 (gap 7.8) — both
# visually confirmed genuine single marks; their "2nd darkest" candidate sat
# at the opposite physical end of the column from the real mark (row0 vs
# row9), consistent with mild vignetting/shadow darkening the column edges
# rather than a real second fill. Lowered to 7.
INT_OUTLIER_TIGHT_MIN_JUMP = 7
INT_OUTLIER_TIGHT_REST_SPREAD_MAX = 8.0

# Outlier fallback for MCQ strips (see get_local_threshold's outlier_min_jump).
# Low-contrast camera photos routinely produce marked/blank gaps well under
# the strict MIN_JUMP=25 cutoff — clearly a single mark to the eye, but not
# to a fixed absolute threshold. Without this, such a row falls all the way
# back to the lenient GLOBAL_DEFAULT_THR (200), which marks every bubble in
# the row as MARKED.
#   - observed 2026-07-28 (batch A): gap=22.4 → whole row multi-marked.
#     Raised the floor from nothing to 15 (MCQ_OUTLIER_MIN_JUMP).
#   - observed 2026-07-28 (batch B, same day): gaps of 14.5 (tn1) and 13.3
#     (tn10) still fell just under 15 → same whole-row multi-mark failure.
#     BUT tn22 (gap 16.6) and tn26 (gap 17.4) in batch A were already
#     correctly accepted at floor=15 — so simply lowering the floor further
#     (tried 10) wrongly REJECTED tn22/tn26 once a naive "gap >= 3x rest
#     spread" relative guard was added on top (their rest-spread of ~6 was
#     not as tight as tn1/tn10's ~1.5, so 3x rest-spread exceeded the gap).
# Fix: two independent acceptance paths instead of one shared cutoff.
#   1) gap >= MCQ_OUTLIER_MIN_JUMP (15)                       — unchanged,
#      covers tn22/tn26-style cases regardless of rest spread.
#   2) gap >= MCQ_OUTLIER_TIGHT_MIN_JUMP (10) AND the OTHER
#      (non-darkest) bubbles cluster within MCQ_OUTLIER_TIGHT_REST_SPREAD_MAX
#      of each other — covers tn1/tn10-style cases where blanks are unusually
#      uniform, making a smaller gap still a confident single outlier.
#
# 2026-07-28 (later still): visually confirmed against the actual scanned
# sheet (both test images) that tn12, tn21-tn23, tn26-tn27, tn29-tn30 and
# tn24-tn25 are ALSO genuine single marks — every one clearly one dark
# circle among untouched blanks — but with rest-spread of 4.0-6.6 (the
# tn11..20 and tn21..30 blocks use bigger bubble ROIs [24x21] / [29x25] than
# tn1..10 [20x19], which naturally picks up more page-texture variance among
# blank bubbles). The 3.0 cap above was fit only to tn1/tn10 and excluded
# these. Raised to 8.0 — still comfortably below where a real second partial
# mark would push one "blank" outlier far below the other two (no such case
# observed; if one shows up, it'll widen rest_spread well past 8).
#
# 2026-07-28 (yet later — new template "temp3"): tn1/tn10/tn31/tn38 showed
# gaps of 8.7-9.7 with rest-spread 1.3-3.2 — visually confirmed genuine
# single marks again, just under the 10 floor by under 1.3px. Every
# previously-confirmed genuine case (this file's whole history above) has
# gap >= 8.7, and every confirmed non-mark/ambiguous case (a truly flat row,
# or a real second partial mark) has gap <= 7.1 — so 8 sits in the gap
# between the two populations observed so far. Lowered the floor to 8.
#
# 2026-07-29 (real user photo, "Mẫu 40" custom template, trc_nghim_abcd21 /
# trc_nghim_abcd38): both fields visually confirmed on the actual scan as a
# single clean mark each (one bubble a well-separated darkest, the other
# three tightly clustered and clearly blank), yet both fell through to
# global_thr → spurious "tô cả 4 đáp án" multi_mark:
#   - abcd21: means [B=100.5, D=115.1, C=117.7, A=123.3]. top2_gap=14.6
#     (misses MCQ_OUTLIER_MIN_JUMP=15 by 0.4), rest_spread=8.2 (misses the
#     old REST_SPREAD_MAX=8.0 by 0.2).
#   - abcd38: means [A=102.0, C=109.4, D=111.2, B=113.1]. top2_gap=7.4
#     (misses the old TIGHT_MIN_JUMP=8 by 0.6) — but still comfortably above
#     the documented non-mark ceiling of 7.1, so it's inside genuine-mark
#     territory, just past the old floor.
# Both are near-misses of an existing acceptance path, not new territory:
# nudged TIGHT_MIN_JUMP down to 7.3 (0.2 clear of the 7.1 non-mark ceiling,
# covers 7.4) and REST_SPREAD_MAX up to 8.3 (covers 8.2, still far below the
# only confirmed genuine multi-mark rest_spread on record, 31.8 — see
# FLAT_STRIP_MAX_SPREAD note below).
MCQ_OUTLIER_MIN_JUMP = 15
MCQ_OUTLIER_TIGHT_MIN_JUMP = 7.3

# 2026-08-04: confirmed real miss — a phiếu's "trắc nghiệm ABCD" câu 25 had
# means [B=101.3, D=112.9, C=119.5, A=121.8] (top2_gap=11.6, rest_spread=8.9).
# User visually confirmed on "Ảnh gốc": only B is filled, the other 3 are
# genuinely blank — yet the field graded BLANK because rest_spread (8.9)
# missed the old ceiling (8.3) by 0.6. Swept the 8.3 → 9.5 change against
# all 829 archived debug means.json files (38,611 four-choice MCQ readings):
# only 16 distinct mean-patterns newly cross into the tight-outlier path,
# every one with the same shape as this confirmed case (one bubble clearly
# separated, the other three within a few px of each other) — no case
# resembling the flat/noisy patterns that FLAT_STRIP_MAX_SPREAD or the
# confirmed-multi-mark rest_spread (31.8, see FLAT_STRIP_MAX_SPREAD note
# below) guard against. Nudged to 9.5 (not just the bare 8.9 minimum) for
# the same "clear the ceiling with a small buffer" margin already used for
# MCQ_OUTLIER_TIGHT_MIN_JUMP above.
MCQ_OUTLIER_TIGHT_REST_SPREAD_MAX = 9.5

# 2026-07-28: a genuinely BLANK strip (no bubble filled at all) can still
# fall through every check above — best_gap < MIN_JUMP, and top2_gap too
# small for even the tight-outlier fallback — because there's simply no
# separation anywhere in the strip. Confirmed on "temp3" tn22 (a row shown
# completely empty in the scan): means [113.0, 112.1, 109.7, 106.8], total
# spread only 6.2. Previously this fell all the way back to global_thr,
# which itself defaults to the hardcoded GLOBAL_DEFAULT_THR=200 whenever
# the whole PAGE also lacks a clean gap (true for this scan: every blank
# bubble measures 65-132, page-wide). Since 200 sits far above all four of
# tn22's means, every bubble in the row was wrongly classified MARKED,
# producing a false "tô cả 4 đáp án" (multi_mark) warning for a blank row.
# A real double/multi-mark always produces much more spread than this
# (every confirmed genuine multi-mark case in this file has rest_spread
# >= 8, most >> 20 — e.g. tn27's confirmed case had rest_spread=31.8), so
# a strip this flat is treated as blank instead of deferring to global_thr.
FLAT_STRIP_MAX_SPREAD = 10.0


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

    2026-07-28: the strict min_jump=25 search can fail on a dark/low-contrast
    photo (e.g. an indoor phone photo) where the real separation between
    inked bubbles and blank paper is genuinely smaller than a well-lit
    flatbed scan's — confirmed on a real photo whose marked cluster topped
    out at 91.6 and blank cluster started at 99.3 (a clean, real gap, just
    narrower than MIN_JUMP=25 expects). When the strict search fails it
    used to fall straight back to GLOBAL_DEFAULT_THR=200 — a value meant
    for near-white scans, but on a dark photo *every* bubble mean sits well
    below 200, so every field relying on this fallback misread the whole
    page as "marked" (widespread spurious multi_mark on genuinely blank
    strips). Now retries once with a relaxed floor before giving up.
    """
    if len(all_means) < 3:
        return global_default

    q_vals = sorted(all_means)
    ls = (looseness + 1) // 2    # = 2 for default looseness=4
    n = len(q_vals)
    l = n - ls

    def _search(floor: float) -> float | None:
        max_gap = floor
        thr: float | None = None
        for i in range(ls, l):
            gap = q_vals[i + ls] - q_vals[i - ls]
            if gap > max_gap:
                max_gap = gap
                thr = q_vals[i - ls] + gap / 2.0
        return thr

    thr = _search(min_jump)
    if thr is not None:
        return thr

    if min_jump > GLOBAL_RELAXED_MIN_JUMP:
        thr = _search(GLOBAL_RELAXED_MIN_JUMP)
        if thr is not None:
            return thr

    return global_default


# ── Step 3: local threshold per strip ────────────────────────────────────

def get_local_threshold(
    strip_means: Sequence[float],
    global_thr: float,
    min_gap: float = MIN_GAP,
    min_jump: float = MIN_JUMP,
    outlier_min_jump: float | None = None,
    return_meta: bool = False,
) -> float | tuple[float, bool]:
    """
    Per-strip (per field_label) adaptive threshold.
    Mirrors OMRChecker ImageInstanceOps.get_local_threshold().

    Args:
        strip_means: Mean values for all bubbles in one field strip.
        global_thr:  Fallback threshold from get_global_threshold().
        min_gap:     Minimum spread to bother with local threshold.
        min_jump:    Minimum gap to count as valid jump in local strip.
        outlier_min_jump:
                     If the primary gap search below doesn't find a gap
                     ≥ min_jump, check whether the single darkest bubble is
                     still clearly separated from the rest: gap ≥
                     outlier_min_jump AND gap ≥ MCQ_OUTLIER_REST_SPREAD_RATIO
                     × (spread among the other bubbles). If so, use their
                     midpoint instead of falling all the way back to
                     global_thr. Mirrors the fallback classify_strip_int()
                     already uses for INT fields — low-contrast photos can
                     produce a real but modest gap that's obviously one
                     marked bubble among a tight cluster of blanks, yet just
                     misses the stricter min_jump. The relative-spread check
                     guards against accepting noise as an outlier when the
                     whole strip has more spread. None (default) preserves
                     the original behaviour.
        return_meta: If True, return (threshold, is_tight_outlier) instead of
                     just the threshold. is_tight_outlier is True only when
                     the threshold came from the tight-cluster fallback (a
                     gap of just 8-14px) — see note below on why callers need
                     this.

    Returns:
        Local threshold (mean_value < local_thr → marked), or a
        (threshold, is_tight_outlier) tuple when return_meta=True.

    IMPORTANT — tight-outlier thresholds need a narrower confidence band:
    classify_strip() normally classifies with a ±CONFIDENT_SURPLUS (5px) band
    around the threshold: MARKED below it, BLANK above, TOO_LIGHT in between.
    That band only makes sense when the underlying gap is comfortably larger
    than 2×CONFIDENT_SURPLUS (10px) — true for the primary best_gap path and
    for the outlier_min_jump=15 path. But the tight-cluster path can return a
    threshold sitting in the middle of a gap as small as 8px, i.e. SMALLER
    than the ±5 band itself. Classifying that with the normal band puts BOTH
    the genuinely-marked bubble and its nearest blank neighbour inside the
    ambiguous zone — instead of one confident MARKED, you get two spurious
    TOO_LIGHT bubbles (observed 2026-07-28, "temp3": tn1 → ['A','D'] both
    TOO_LIGHT instead of a clean single 'A'). Callers must check
    is_tight_outlier and pass confident_surplus=0 to classify_strip() for
    that strip so it falls back to a plain "< threshold ⇒ marked" split with
    no ambiguity band — appropriate here because the gap/rest-spread checks
    that produced this threshold already establish confidence some other way.
    """
    q_vals = sorted(strip_means)
    n = len(q_vals)

    def _ret(thr: float, tight: bool = False) -> float | tuple[float, bool]:
        return (thr, tight) if return_meta else thr

    # Too few points → use global
    if n < 3:
        spread = q_vals[-1] - q_vals[0] if n > 1 else 0
        # 2026-07-28: a 2-choice row (e.g. a Đúng/Sai field, or the
        # signed-decimal composite's decimal-position sub-field, both of
        # which always have exactly n=2 candidate bubbles) hits this n<3
        # branch on EVERY read — it never reaches the FLAT_STRIP_MAX_SPREAD
        # check further down, which only guards the n>=3 gap-search path.
        # A genuinely blank 2-choice row (both bubbles equally unmarked,
        # spread only a couple of px) was falling back to global_thr here,
        # and on a photo whose whole-page blank baseline sits unusually low
        # (dark/low-contrast phone photo), global_thr can end up ABOVE both
        # bubbles' means — marking both MARKED (a spurious multi_mark on a
        # blank row). Confirmed on a real photo 2026-07-28: a Đúng/Sai
        # row's Đ/S means were 127.4/127.0 (spread 0.4) yet global_thr was
        # high enough to flag both. Apply the same flat-strip reasoning
        # used below: if the 2 points are this close together, there's no
        # real separation to speak of — treat as blank instead of trusting
        # a possibly-miscalibrated global_thr.
        #
        # Deliberately scoped to n==2 only (NOT n==1): a single-bubble-value
        # field (e.g. the composite sign "-") has no second point to compare
        # against at all, so "spread" is trivially 0 regardless of whether
        # the one bubble is genuinely marked or blank — treating that as
        # "always flat ⇒ always blank" would make a real mark on a
        # single-choice field undetectable. n==1 keeps relying on
        # global_thr exactly as before (a separate, harder problem: no
        # local comparison point exists at all for a lone bubble).
        if n == 2 and outlier_min_jump is not None and spread <= FLAT_STRIP_MAX_SPREAD:
            return _ret(q_vals[0] - CONFIDENT_SURPLUS - 1.0)
        return _ret(global_thr if spread < min_gap else float(np.mean(q_vals)))

    # Find the single largest gap in this strip
    best_gap = 0.0
    local_thr = global_thr
    for i in range(1, n):
        gap = q_vals[i] - q_vals[i - 1]
        if gap > best_gap:
            best_gap = gap
            local_thr = (q_vals[i] + q_vals[i - 1]) / 2.0

    # Only use local if gap is meaningful
    if best_gap >= min_jump:
        return _ret(local_thr)

    if outlier_min_jump is not None:
        top2_gap = q_vals[1] - q_vals[0]
        if top2_gap >= outlier_min_jump:
            return _ret((q_vals[0] + q_vals[1]) / 2.0)
        rest_spread = q_vals[-1] - q_vals[1]
        if top2_gap >= MCQ_OUTLIER_TIGHT_MIN_JUMP and rest_spread <= MCQ_OUTLIER_TIGHT_REST_SPREAD_MAX:
            return _ret((q_vals[0] + q_vals[1]) / 2.0, tight=True)

        # No separation anywhere in the strip at all: treat as a genuinely
        # blank row instead of falling back to global_thr (see
        # FLAT_STRIP_MAX_SPREAD comment above for why). Return a threshold
        # safely below the darkest value in the strip so every bubble
        # classifies BLANK, not MARKED/TOO_LIGHT.
        #
        # Scoped to outlier_min_jump-is-not-None (the MCQ caller in
        # engine.py) ONLY. classify_strip_int() also calls this function
        # (without outlier_min_jump) and relies on `eff_thr == global_thr`
        # to detect "no local separation found" so it can run its OWN
        # outlier fallback for INT digit columns; if this flat-strip branch
        # fired there too, eff_thr would never equal global_thr for a flat
        # INT strip and that fallback would be silently skipped. Confirmed
        # via regression sweep 2026-07-28: adding this check unscoped
        # produced spurious multi_mark on m_sv2/m_sv3/m_sv5/m_sv7/m_sv8
        # (INT columns) that vanished once scoped to the MCQ-only branch.
        strip_spread = q_vals[-1] - q_vals[0]
        if strip_spread <= FLAT_STRIP_MAX_SPREAD:
            return _ret(q_vals[0] - CONFIDENT_SURPLUS - 1.0)

    return _ret(global_thr)


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
    is_tight_outlier = False
    if eff_thr == global_thr and len(strip_means) >= 2:
        sorted_m = sorted(strip_means)
        top2_gap = sorted_m[1] - sorted_m[0]  # gap between darkest and 2nd-darkest
        if top2_gap >= INT_MIN_JUMP:
            # One bubble is a clear outlier: threshold at the midpoint.
            eff_thr = (sorted_m[0] + sorted_m[1]) / 2.0
        else:
            # Tight-cluster fallback: even a smaller gap is trustworthy if
            # every other digit in the column is nearly identical (see
            # INT_OUTLIER_TIGHT_* comment above).
            rest_spread = sorted_m[-1] - sorted_m[1]
            if top2_gap >= INT_OUTLIER_TIGHT_MIN_JUMP and rest_spread <= INT_OUTLIER_TIGHT_REST_SPREAD_MAX:
                eff_thr = (sorted_m[0] + sorted_m[1]) / 2.0
                is_tight_outlier = True
            else:
                # 2026-07-29: a genuinely BLANK digit column (no digit filled
                # at all) can fail every check above — top2_gap too small even
                # for the tight-cluster fallback — because there's no
                # separation anywhere in the column. Confirmed on real data:
                # a blank "custom_..._d1" column had means clustered
                # 104.4-107.1 (spread 2.7), yet global_thr for that page's
                # gap search also fell back to the hardcoded
                # GLOBAL_DEFAULT_THR=200 (the page's real marked/blank gap
                # was 8.17, under GLOBAL_RELAXED_MIN_JUMP=10). With eff_thr
                # stuck at 200 — far above every one of the column's actual
                # means — every digit in the column classified MARKED,
                # producing a false multi-digit read (e.g. "87") for a
                # visibly blank box.
                # Mirrors the identical FLAT_STRIP_MAX_SPREAD fix already
                # applied to the MCQ path in get_local_threshold() (see that
                # function's docstring) — this is the same fix for the INT
                # path, which needs its own copy because classify_strip_int()
                # calls get_local_threshold() WITHOUT outlier_min_jump (so
                # that function's own flat-strip branch never fires for INT
                # columns; see the scoping note on that branch).
                strip_spread = sorted_m[-1] - sorted_m[0]
                if strip_spread <= FLAT_STRIP_MAX_SPREAD:
                    eff_thr = sorted_m[0] - confident_surplus - 1.0

    # A tight-cluster threshold can sit inside a gap as small as 8px —
    # smaller than the normal ±confident_surplus (5px) TOO_LIGHT band. Using
    # that band here would catch BOTH the marked digit and its nearest blank
    # neighbour as ambiguous instead of one confident MARKED (observed
    # 2026-07-28, "temp3": m_sv2/m_sv4/m_sv5 each produced two spurious
    # TOO_LIGHT digits instead of a clean single mark). Same fix as
    # get_local_threshold's is_tight_outlier for MCQ: fall back to a hard
    # "< threshold ⇒ marked" split with no ambiguity band for this strip.
    effective_surplus = 0.0 if is_tight_outlier else confident_surplus
    lo = eff_thr - effective_surplus
    hi = eff_thr + effective_surplus

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
