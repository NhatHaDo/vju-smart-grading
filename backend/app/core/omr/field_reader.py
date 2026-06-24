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
MCQ_GAP_MIN_CONFIDENT = 20


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
        return FieldResult(
            field_label=field_label,
            field_type=field_type,
            selected_value=None,
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
    if gap < MCQ_GAP_MIN_CONFIDENT:
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
