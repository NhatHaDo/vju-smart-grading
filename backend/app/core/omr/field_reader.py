"""
field_reader.py
===============
Interpret BubbleReading lists into field-level results.

For each field_label, the reader determines:
- What was selected (digit or A/B/C/D)
- Whether it's blank, multi-marked, or needs review

Field-type dispatch:
  QTYPE_INT_FROM_1 → read_int_field()
  QTYPE_MCQ4       → read_mcq_field()
  (others can be added)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from app.core.omr.bubble_analyzer import BubbleReading, BubbleStatus

# ── MCQ decision constants ────────────────────────────────────────────────
# A single MARKED bubble must be at least this many mean-pixel units darker
# than the next-darkest bubble in the same row to be accepted as a confident
# answer.  If the gap is smaller the result is flagged as NEEDS_REVIEW so a
# human can verify — this prevents near-threshold ambiguities from turning
# into wrong answers.
#
# 2026-07-28: observed real single-answer rows (tn4, tn5, tn21, tn22, tn26,
# tn27 in "Template 2") with gaps of 16.6-19.9 — clean, singly-marked bubbles
# that classify_strip() already confidently separated from the rest — being
# wrongly downgraded to NEEDS_REVIEW by the old threshold of 20. Genuine
# answered rows in the same scan had gaps of 20.1+, so 20 was a cliff-edge
# cutting into legitimate answers. Lowered to 15 to match the analogous
# MCQ_OUTLIER_MIN_JUMP constant in bubble_analyzer.py.
#
# 2026-07-28 (later same day): tn1 and tn10 (gaps 14.5 and 13.3) still fell
# just under 15, once classify_strip's own tight-cluster fallback (see
# MCQ_OUTLIER_TIGHT_* in bubble_analyzer.py) started correctly isolating them
# as single MARKED bubbles — this redundant gap check then re-flagged them
# NEEDS_REVIEW anyway. Added the same two-path rule here: the primary 15px
# floor stays for the general case, plus a lower floor (10px) when the other
# 3 bubbles in the row are unusually tight (near-identical), which is a
# reliable sign of a genuine single mark even with a smaller gap.
#
# 2026-07-28 (later still): visually confirmed tn12, tn21-23, tn26-27,
# tn29-30, tn24-25 are also genuine single marks with rest-spread 4.0-6.6
# (bigger-bubble columns naturally vary more among blanks). Raised the tight
# rest-spread cap to 8.0 to match bubble_analyzer.py's MCQ_OUTLIER_TIGHT_REST_SPREAD_MAX
# so this redundant check doesn't re-reject what classify_strip now accepts.
#
# 2026-07-28 (yet later — template "temp3"): tn1/tn10/tn31/tn38 confirmed
# genuine single marks with gaps 8.7-9.7, just under the 10 floor. Lowered
# to 8 to match bubble_analyzer.py's MCQ_OUTLIER_TIGHT_MIN_JUMP — keep these
# two constants in sync, they gate the same decision at two layers.
#
# 2026-07-29: got out of sync — bubble_analyzer.py's MCQ_OUTLIER_TIGHT_MIN_JUMP
# / MCQ_OUTLIER_TIGHT_REST_SPREAD_MAX were nudged to 7.3 / 8.3 (real user
# photo, trc_nghim_abcd21/38 — see that file's 2026-07-29 comment for the
# evidence), but this redundant copy was missed. Result: classify_strip()
# correctly isolated a single confident MARKED bubble for both fields, but
# THIS gap check re-evaluated the same means against the still-old 8 / 8.0
# floor and downgraded both back to NEEDS_REVIEW anyway — confirmed via a
# fresh regrade showing status "needs_review" for abcd21 even after the
# bubble_analyzer.py fix was deployed and verified in isolation. Mirroring
# the same values here so the two layers agree again.
MCQ_GAP_MIN_CONFIDENT = 15
MCQ_GAP_TIGHT_MIN_CONFIDENT = 7.3
MCQ_GAP_TIGHT_REST_SPREAD_MAX = 8.3


# ── Result types ──────────────────────────────────────────────────────────

class FieldStatus(str, Enum):
    BLANK        = "blank"
    ANSWERED     = "answered"
    MULTI_MARK   = "multi_mark"
    TOO_LIGHT    = "too_light"
    INVALID      = "invalid"
    NEEDS_REVIEW = "needs_review"


@dataclass
class FieldResult:
    field_label: str
    field_type: str
    selected_value: str | None            # e.g. "5", "A", or None if blank
    selected_values: list[str] = field(default_factory=list)   # all marked values
    status: FieldStatus = FieldStatus.BLANK
    fill_ratios: dict[str, float] = field(default_factory=dict) # value → fill_ratio
    # Per-column warnings for INT fields (multi-mark, ambiguous, …)
    # Each entry: {field, reason, selected_digits, details:[{digit, mean, fill_ratio, status}]}
    column_warnings: list[dict] = field(default_factory=list)


# ── Per-type readers ──────────────────────────────────────────────────────

def read_field(
    field_label: str,
    field_type: str,
    readings: list[BubbleReading],
) -> FieldResult:
    """
    Dispatch to the appropriate field reader based on fieldType.
    `readings` must be in bubble_value order for the given field_label.

    INT types (QTYPE_INT_FROM_1, QTYPE_INT):
      → _read_column_int_field — allows multi-mark (concatenates digits),
        uses adaptive threshold, populates column_warnings with details.

    MCQ types:
      → _read_row_field — single-answer expected, multi-mark = error.
    """
    if field_type in ("QTYPE_INT_FROM_1", "QTYPE_INT"):
        return _read_column_int_field(field_label, field_type, readings)
    elif field_type in ("QTYPE_MCQ4", "QTYPE_MCQ5", "QTYPE_MCQ4_RTL", "QTYPE_MCQ5_RTL"):
        return _read_row_field(field_label, field_type, readings)
    else:
        # Generic fallback: pick any single MARKED bubble
        return _read_row_field(field_label, field_type, readings)


def _read_row_field(
    field_label: str,
    field_type: str,
    readings: list[BubbleReading],
) -> FieldResult:
    """
    MCQ row field: expect exactly one MARKED bubble in the row.
    """
    fill_ratios = {r.bubble.bubble_value: r.fill_ratio for r in readings}
    marked = [r for r in readings if r.status == BubbleStatus.MARKED]
    light  = [r for r in readings if r.status == BubbleStatus.TOO_LIGHT]

    selected_values = [r.bubble.bubble_value for r in marked]

    if len(marked) == 0 and len(light) == 0:
        return FieldResult(
            field_label=field_label,
            field_type=field_type,
            selected_value=None,
            selected_values=[],
            status=FieldStatus.BLANK,
            fill_ratios=fill_ratios,
        )

    if len(marked) == 0 and len(light) == 1:
        # Single faint mark — NOT accepted as a final answer.
        # A TOO_LIGHT bubble is near-threshold and could be a printed ring
        # or scan artifact.  Flag for human review instead of guessing.
        val = light[0].bubble.bubble_value
        return FieldResult(
            field_label=field_label,
            field_type=field_type,
            selected_value=None,           # no confident answer
            selected_values=[val],         # kept as candidate for overlay / warning
            status=FieldStatus.NEEDS_REVIEW,
            fill_ratios=fill_ratios,
        )

    if len(marked) == 0 and len(light) > 1:
        # Multiple faint marks — can't pick one
        light_values = [r.bubble.bubble_value for r in light]
        return FieldResult(
            field_label=field_label,
            field_type=field_type,
            selected_value=None,
            selected_values=light_values,
            status=FieldStatus.NEEDS_REVIEW,
            fill_ratios=fill_ratios,
        )

    if len(marked) > 1:
        # 2026-08-04: "kiểu câu này multi 2 đáp án A và C thì phải ghi cả
        # 'AC' như này chứ" — used to leave selected_value=None here (an MCQ
        # multi-mark was "an error, no answer" by design — see this
        # function's docstring), showing blank/"—" even though the sheet
        # clearly has 2+ bubbles filled in. Now concatenates the marked
        # values in template/bubble order (readings is guaranteed to be in
        # bubble_value order — see read_field()'s docstring), same
        # convention _read_column_int_field() already uses for INT columns.
        # Status stays MULTI_MARK (still flagged "cần xem lại phiếu gốc" —
        # scorer.py only awards credit when status == ANSWERED, so this never
        # silently counts as correct just because it now has a display value).
        return FieldResult(
            field_label=field_label,
            field_type=field_type,
            selected_value="".join(selected_values),
            selected_values=selected_values,
            status=FieldStatus.MULTI_MARK,
            fill_ratios=fill_ratios,
        )

    # len(marked) == 1 — gap check: the MARKED bubble must be clearly darker
    # than every other bubble in the row.  If the gap is too small the
    # detection is uncertain (could be a ring FP that slipped past the
    # center-fill guard) → NEEDS_REVIEW instead of committing to a wrong answer.
    val = marked[0].bubble.bubble_value
    marked_mean = marked[0].mean_value
    other_means = [r.mean_value for r in readings if r is not marked[0]]
    gap = (min(other_means) - marked_mean) if other_means else MCQ_GAP_MIN_CONFIDENT
    confident = gap >= MCQ_GAP_MIN_CONFIDENT
    if not confident and other_means:
        rest_spread = max(other_means) - min(other_means)
        confident = gap >= MCQ_GAP_TIGHT_MIN_CONFIDENT and rest_spread <= MCQ_GAP_TIGHT_REST_SPREAD_MAX
    if not confident:
        return FieldResult(
            field_label=field_label,
            field_type=field_type,
            selected_value=None,           # uncertain — do not count as answer
            selected_values=[val],         # candidate for display
            status=FieldStatus.NEEDS_REVIEW,
            fill_ratios=fill_ratios,
        )
    return FieldResult(
        field_label=field_label,
        field_type=field_type,
        selected_value=val,
        selected_values=[val],
        status=FieldStatus.ANSWERED,
        fill_ratios=fill_ratios,
    )


# Maximum number of candidates to accept per INT column before triggering
# over-detect guard (more than this → something is wrong with the threshold).
INT_MAX_CANDIDATES = 2


def _read_column_int_field(
    field_label: str,
    field_type: str,
    readings: list[BubbleReading],
) -> FieldResult:
    """
    INT digit-column reader — conservative multi-mark handling.

    Decision table
    --------------
    0 MARKED, 0 LIGHT           → BLANK
    1 MARKED, 0 LIGHT           → ANSWERED  (clean single digit)
    1 MARKED, ≥1 LIGHT          → ANSWERED  (take the clearly marked digit;
                                              TOO_LIGHT siblings discarded with warn)
    0 MARKED, 1 LIGHT           → TOO_LIGHT (single faint mark, accept with warn)
    0 MARKED, ≥2 LIGHT          → TOO_LIGHT (take only the darkest light;
                                              others discarded — multiple TOO_LIGHT
                                              are almost certainly noise/printed ink)
    2 MARKED                    → MULTI_MARK, selected_value = concat in template order
    >INT_MAX_CANDIDATES MARKED  → over-detect guard fires:
                                   keep only top-2 darkest, warn "over_detect_info_field"

    TOO_LIGHT entries are NEVER concatenated with MARKED ones.  The
    rationale: TOO_LIGHT means "near-threshold, possibly just the printed
    digit outline".  Only unambiguously MARKED bubbles are genuine user fills.

    column_warnings format
    ----------------------
    Each entry:
      {
        "field":           "cccd3",
        "reason":          "multi_mark_info_field" | "over_detect_info_field" |
                           "too_light_info_field"  | "too_light_discarded",
        "selected_digits": ["2", "5"],
        "details": [
          {"digit": "2", "mean": 162.4, "fill_ratio": 0.637, "status": "marked"},
          …
        ],
      }
    """
    fill_ratios = {r.bubble.bubble_value: r.fill_ratio for r in readings}
    marked = [r for r in readings if r.status == BubbleStatus.MARKED]
    light  = [r for r in readings if r.status == BubbleStatus.TOO_LIGHT]
    column_warnings: list[dict] = []

    def _warn(candidates: list[BubbleReading], reason: str) -> dict:
        return {
            "field":           field_label,
            "reason":          reason,
            "selected_digits": [r.bubble.bubble_value for r in candidates],
            "details": [
                {
                    "digit":      r.bubble.bubble_value,
                    "mean":       round(r.mean_value, 1),
                    "fill_ratio": round(r.fill_ratio, 3),
                    "status":     r.status.value,
                }
                for r in candidates
            ],
        }

    # ── No hits ──────────────────────────────────────────────────────────
    if not marked and not light:
        return FieldResult(
            field_label=field_label, field_type=field_type,
            selected_value=None, selected_values=[],
            status=FieldStatus.BLANK, fill_ratios=fill_ratios,
        )

    # ── 1 clearly MARKED (the normal case) ───────────────────────────────
    if len(marked) == 1:
        val = marked[0].bubble.bubble_value
        if light:
            # TOO_LIGHT siblings are near-threshold noise; discard them.
            column_warnings.append(_warn(light, "too_light_discarded"))
        return FieldResult(
            field_label=field_label, field_type=field_type,
            selected_value=val, selected_values=[val],
            status=FieldStatus.ANSWERED, fill_ratios=fill_ratios,
            column_warnings=column_warnings,
        )

    # ── No MARKED — only TOO_LIGHT hits ──────────────────────────────────
    if not marked:
        if len(light) == 1:
            val = light[0].bubble.bubble_value
            column_warnings.append(_warn(light, "too_light_info_field"))
            return FieldResult(
                field_label=field_label, field_type=field_type,
                selected_value=val, selected_values=[val],
                status=FieldStatus.TOO_LIGHT, fill_ratios=fill_ratios,
                column_warnings=column_warnings,
            )
        # Multiple TOO_LIGHT: take only the darkest one (lowest mean).
        # Multiple near-threshold bubbles are almost certainly noise or
        # printed-digit false positives — do NOT concatenate them all.
        darkest = min(light, key=lambda r: r.mean_value)
        val = darkest.bubble.bubble_value
        column_warnings.append(_warn(light, "multi_light_discarded_info_field"))
        return FieldResult(
            field_label=field_label, field_type=field_type,
            selected_value=val, selected_values=[val],
            status=FieldStatus.TOO_LIGHT, fill_ratios=fill_ratios,
            column_warnings=column_warnings,
        )

    # ── ≥2 MARKED ────────────────────────────────────────────────────────
    if len(marked) > INT_MAX_CANDIDATES:
        # Over-detect: classifier returned too many candidates.
        # Keep only the 2 darkest (most confidently marked).
        top2 = sorted(marked, key=lambda r: r.mean_value)[:INT_MAX_CANDIDATES]
        vals = [r.bubble.bubble_value for r in top2]
        column_warnings.append(_warn(marked, "over_detect_info_field"))
        return FieldResult(
            field_label=field_label, field_type=field_type,
            selected_value="".join(vals), selected_values=vals,
            status=FieldStatus.MULTI_MARK, fill_ratios=fill_ratios,
            column_warnings=column_warnings,
        )

    # Exactly INT_MAX_CANDIDATES (2) MARKED — genuine multi-mark.
    # Concatenate in the order they appear in readings (= template order).
    vals = [r.bubble.bubble_value for r in marked]
    column_warnings.append(_warn(marked, "multi_mark_info_field"))
    return FieldResult(
        field_label=field_label, field_type=field_type,
        selected_value="".join(vals), selected_values=vals,
        status=FieldStatus.MULTI_MARK, fill_ratios=fill_ratios,
        column_warnings=column_warnings,
    )


def _read_column_field(
    field_label: str,
    field_type: str,
    readings: list[BubbleReading],
) -> FieldResult:
    """
    INT column field: expect exactly one MARKED bubble in the column.
    Returns the digit value ("0".."9") of the marked bubble.
    """
    fill_ratios = {r.bubble.bubble_value: r.fill_ratio for r in readings}
    marked = [r for r in readings if r.status == BubbleStatus.MARKED]
    light  = [r for r in readings if r.status == BubbleStatus.TOO_LIGHT]

    selected_values = [r.bubble.bubble_value for r in marked]

    if len(marked) == 0 and len(light) == 0:
        return FieldResult(
            field_label=field_label,
            field_type=field_type,
            selected_value=None,
            selected_values=[],
            status=FieldStatus.BLANK,
            fill_ratios=fill_ratios,
        )

    if len(marked) == 0 and len(light) == 1:
        val = light[0].bubble.bubble_value
        return FieldResult(
            field_label=field_label,
            field_type=field_type,
            selected_value=val,
            selected_values=[val],
            status=FieldStatus.TOO_LIGHT,
            fill_ratios=fill_ratios,
        )

    if len(marked) == 0 and len(light) > 1:
        light_values = [r.bubble.bubble_value for r in light]
        return FieldResult(
            field_label=field_label,
            field_type=field_type,
            selected_value=None,
            selected_values=light_values,
            status=FieldStatus.NEEDS_REVIEW,
            fill_ratios=fill_ratios,
        )

    if len(marked) > 1:
        return FieldResult(
            field_label=field_label,
            field_type=field_type,
            selected_value=None,
            selected_values=selected_values,
            status=FieldStatus.MULTI_MARK,
            fill_ratios=fill_ratios,
        )

    val = marked[0].bubble.bubble_value
    return FieldResult(
        field_label=field_label,
        field_type=field_type,
        selected_value=val,
        selected_values=[val],
        status=FieldStatus.ANSWERED,
        fill_ratios=fill_ratios,
    )


# ── Custom-label aggregation ──────────────────────────────────────────────

def aggregate_custom_label(
    custom_key: str,
    component_labels: list[str],
    field_results: dict[str, FieldResult],
    empty_val: str = "",
) -> tuple[str, FieldStatus]:
    """
    Concatenate multiple INT-column results into one multi-digit value.
    e.g. CCCD = cccd1+cccd2+...+cccd12 → "012345678901"

    Returns (concatenated_string, aggregated_status).
    Status is NEEDS_REVIEW if any component is MULTI_MARK, TOO_LIGHT, or BLANK.
    """
    parts: list[str] = []
    has_issue = False

    for label in component_labels:
        result = field_results.get(label)
        if result is None or result.selected_value is None:
            parts.append(empty_val or "_")
            has_issue = True
        else:
            parts.append(result.selected_value)
            if result.status != FieldStatus.ANSWERED:
                has_issue = True

    value = "".join(parts)
    status = FieldStatus.NEEDS_REVIEW if has_issue else FieldStatus.ANSWERED
    return value, status


# ── Composite signed-decimal aggregation ──────────────────────────────────

def aggregate_signed_decimal(
    sign_result:  FieldResult | None,
    dec_result:   FieldResult | None,
    digit_results: list[FieldResult | None],
) -> tuple[str | None, FieldStatus, list[dict]]:
    """
    Combine a sign column + a decimal-position column + N digit columns into
    one signed-decimal answer string (e.g. "-12.3"), for "Phần IV"-style
    fill-in-the-blank numeric questions (2026-07-28).

    sign_result:   FieldResult for the 1-bubble "-" column, or None if this
                   question has no sign sub-field at all (never negative).
    dec_result:    FieldResult for the decimal-position column, or None if
                   this question is always a plain integer. Its selected
                   value is a digit COUNT ("1", "2", …) — the decimal point
                   is inserted after that many leading digits.
    digit_results: FieldResult per digit column, left-to-right order. Each
                   may be None (block/label missing — shouldn't normally
                   happen, treated like a blank digit).

    Returns (value, status, warnings):
      value:   formatted string, or None if the whole question is blank
               (every sub-field completely unanswered).
      status:  BLANK (nothing filled at all) | ANSWERED (every sub-field
               clean) | NEEDS_REVIEW (some sub-field ambiguous/partial) |
               MULTI_MARK (a sub-field itself came back multi-marked).
      warnings: list of {field, type, candidates} dicts, same shape as the
                rest of the warnings pipeline, one per problematic sub-field.
    """
    warnings: list[dict] = []

    def _is_blank(r: FieldResult | None) -> bool:
        return r is None or r.status == FieldStatus.BLANK

    all_blank = (
        _is_blank(sign_result)
        and _is_blank(dec_result)
        and all(_is_blank(r) for r in digit_results)
    )
    if all_blank:
        return None, FieldStatus.BLANK, warnings

    # 2026-07-29: the "-" sign bubble is a lone 1-bubble column (n=1) — it
    # has no sibling bubble in its own strip to compare against, so unlike
    # every other field type here it can't fall back to a local/tight-outlier
    # comparison when the page-wide gap search fails; it depends entirely on
    # global_thr. On a low-contrast photo that threshold can land above a
    # genuinely blank sign bubble even while every digit/dec column of the
    # SAME question (10 candidates each, so a reliable local baseline) reads
    # correctly blank. Confirmed on a real user photo: sign mean 132.0 was
    # literally the lightest (most blank-looking) bubble in its own group —
    # d1-d4 ranged 121.8-132.1, dec 130.6-131.7 — yet was the only one
    # flagged MARKED. A "-" with not a single digit filled in isn't a
    # sensible answer either way, so treat "sign marked, everything else in
    # the group blank" as a false read on the sign bubble rather than a
    # genuine partial answer.
    sign_only = (
        sign_result is not None
        and sign_result.status == FieldStatus.ANSWERED
        and sign_result.selected_value == "-"
        and _is_blank(dec_result)
        and all(_is_blank(r) for r in digit_results)
    )
    if sign_only:
        return None, FieldStatus.BLANK, warnings

    has_issue = False

    # ── Sign ───────────────────────────────────────────────────────────────
    sign_str = ""
    if sign_result is not None and sign_result.status != FieldStatus.BLANK:
        if sign_result.status == FieldStatus.ANSWERED and sign_result.selected_value == "-":
            sign_str = "-"
        else:
            has_issue = True
            warnings.append({
                "field": sign_result.field_label, "type": sign_result.status.value,
                "candidates": sign_result.selected_values,
            })

    # ── Digits ───────────────────────────────────────────────────────────────
    digit_chars: list[str] = []
    for r in digit_results:
        if r is None or r.selected_value is None:
            digit_chars.append("_")
            has_issue = True
            if r is not None and r.status != FieldStatus.BLANK:
                warnings.append({
                    "field": r.field_label, "type": r.status.value,
                    "candidates": r.selected_values,
                })
        else:
            digit_chars.append(r.selected_value)
            if r.status != FieldStatus.ANSWERED:
                has_issue = True
                warnings.append({
                    "field": r.field_label, "type": r.status.value,
                    "candidates": r.selected_values,
                })
    digits = "".join(digit_chars)

    # ── Decimal position ────────────────────────────────────────────────────
    dec_count: int | None = None
    if dec_result is not None and dec_result.status != FieldStatus.BLANK:
        if dec_result.status == FieldStatus.ANSWERED and dec_result.selected_value is not None:
            try:
                dec_count = int(dec_result.selected_value)
            except ValueError:
                has_issue = True
        else:
            has_issue = True
        if dec_count is None or dec_result.status != FieldStatus.ANSWERED:
            warnings.append({
                "field": dec_result.field_label, "type": dec_result.status.value,
                "candidates": dec_result.selected_values,
            })

    if dec_count is not None and 0 < dec_count < len(digits):
        value = f"{sign_str}{digits[:dec_count]}.{digits[dec_count:]}"
    else:
        value = f"{sign_str}{digits}"

    status = FieldStatus.NEEDS_REVIEW if has_issue else FieldStatus.ANSWERED
    return value, status, warnings
