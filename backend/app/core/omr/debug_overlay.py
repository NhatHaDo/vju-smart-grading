"""
debug_overlay.py
================
Draw bubble ROIs, classification results, and mean intensity values on
the full pageDimensions image for visual verification.

Key rules (per Phase 4 rev2 spec):
  - ALWAYS draw on the pageDimensions image (2550×3301 AFTER alignment).
  - Show mean intensity value inside each bubble rect/circle.
  - draw_mode controls shape: "rect" | "circle" | "both"

Usage:
    overlay = draw_template_overlay(image, template, field_results, bubble_means,
                                     draw_mode="both")
    save_overlay(overlay, "results/debug_overlays/check.jpg")

Additional overlay modes:
    draw_overlay_marked_only(image, template, field_results)
        → Only MARKED bubbles, RED circle, "field:value" label
    draw_overlay_warnings(image, template, field_results)
        → Only MULTI_MARK / TOO_LIGHT / NEEDS_REVIEW bubbles, orange/yellow
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from app.core.omr.field_reader import FieldResult, FieldStatus
from app.core.omr.template_geometry import bounding_box
from app.core.templates.template_loader import BubbleSpec, VJUTemplate


# ── Colour palette (BGR) ──────────────────────────────────────────────────

CLR_BUBBLE_DEFAULT = (150, 150, 150)   # gray        — no results / unread
CLR_BUBBLE_MARKED  = (0,   200, 0)     # green       — MARKED / ANSWERED (also "đúng" when answer-key correctness is known)
CLR_BUBBLE_BLANK   = (130, 130, 130)   # gray        — BLANK
CLR_BUBBLE_LIGHT   = (0,   140, 255)   # orange      — TOO_LIGHT
CLR_BUBBLE_MULTI   = (0,   0,   210)   # red         — MULTI_MARK (also "sai" when answer-key correctness is known)
CLR_BUBBLE_REVIEW  = (0,   180, 230)   # yellow-ish  — NEEDS_REVIEW
CLR_BUBBLE_INVALID = (60,  60,  60)    # dark gray   — INVALID

# 2026-08-03: "để câu đúng xanh câu sai đỏ câu lỗi vàng nhé" — when an answer
# key was supplied to the grading request, a clean ANSWERED bubble is now
# coloured by correctness instead of always green; TOO_LIGHT / MULTI_MARK /
# NEEDS_REVIEW ("câu bị hệ thống cảnh báo") are consolidated into ONE "lỗi"
# colour regardless of correctness (previously 3 different shades). Reusing
# the existing green/red/yellow-ish tones above keeps this a pure remap, not
# a new palette — CLR_BUBBLE_WRONG is the one genuinely new colour needed.
CLR_BUBBLE_CORRECT = CLR_BUBBLE_MARKED   # green — "câu đúng"
CLR_BUBBLE_WRONG    = (0,   0,   220)    # red   — "câu sai"
CLR_BUBBLE_FLAGGED  = CLR_BUBBLE_REVIEW  # yellow-ish — "câu lỗi" (multi/too-light/needs-review, any correctness)
CLR_BLOCK_OUTLINE  = (180, 0,   180)   # purple      — block bounding box
CLR_BLOCK_LABEL    = (180, 0,   180)
CLR_MEAN_TEXT      = (0,   0,   170)   # dark red    — mean intensity text
CLR_VALUE_TEXT     = (20,  20,  20)    # near-black  — bubble value label
CLR_CENTER_DOT     = (0,   220, 255)   # cyan        — center dot

# Overlay-mode specific colours
CLR_MARKED_OK      = (30,  160, 30)    # green       — answered correctly
CLR_MARKED_MULTI   = (0,   0,   220)   # red (BGR)   — multi-mark
CLR_MARKED_LIGHT   = (0,   140, 255)   # orange      — too light
CLR_MARKED_REVIEW  = (0,   180, 230)   # yellow-ish  — needs review
CLR_MARKED_ONLY    = (0,   0,   220)   # red (BGR)   — marked_only border (legacy)
CLR_MARKED_LABEL_OK    = (20,  120, 20)    # dark green — label for answered
CLR_MARKED_LABEL_MULTI = (0,   0,   180)   # dark red   — label for multi
CLR_MARKED_LABEL_WARN  = (0,   80,  200)   # dark orange — label for warnings
CLR_WARN_MULTI     = (0,   100, 255)   # orange      — MULTI_MARK
CLR_WARN_LIGHT     = (0,   200, 255)   # yellow      — TOO_LIGHT
CLR_WARN_REVIEW    = (0,   200, 230)   # yellow-ish  — NEEDS_REVIEW
CLR_WARN_LABEL     = (0,   60,  200)   # dark orange — warning text

BUBBLE_LINE_WIDTH  = 2
BUBBLE_LINE_THICK  = 3                 # thicker for marked/warning overlays
FONT               = cv2.FONT_HERSHEY_SIMPLEX
FONT_SCALE_VALUE   = 0.38
FONT_SCALE_MEAN    = 0.30
FONT_SCALE_LABEL   = 0.34             # for "field:value" labels
FONT_THICKNESS     = 1
FONT_THICKNESS_BOLD = 2

# Valid draw modes
DRAW_MODES = ("rect", "circle", "both")

# ── Selected-bubble highlight style ──────────────────────────────────────────
# Big label (A/B/C/D or digit) drawn centered ON the bubble, with a
# semi-transparent coloured box behind it so results are readable at 100% zoom.

SELECTED_LABEL_FONT_SCALE_BASE = 0.9   # multiplied by (bubble_w / 32) → scales with sheet resolution
SELECTED_LABEL_THICKNESS       = 2     # font stroke weight for big labels
SELECTED_BOX_ALPHA             = 0.42  # 0 = invisible, 1 = fully opaque fill
SELECTED_BOX_PADDING           = 3     # extra px around bubble for the box

# Box fill colours (BGR) per status
_BOX_ANSWERED   = (155, 155, 155)      # gray        — clean single answer (no answer-key correctness known)
_BOX_MULTI_MCQ  = (60,   60, 215)      # red         — unexpected MCQ multi-mark
_BOX_MULTI_INT  = (30,  150, 230)      # orange      — INT multi-digit (normal)
_BOX_LIGHT      = (30,  150, 230)      # orange      — too-light mark
_BOX_REVIEW     = (30,  200, 230)      # yellow      — needs review
_BOX_DEFAULT    = (155, 155, 155)      # gray        — fallback

# 2026-08-03: correctness-aware box fills, used instead of _BOX_ANSWERED when
# an answer key resolved this label's correctness — see _draw_selected_bubble_highlight.
_BOX_CORRECT = (30,  160, 30)          # green — "câu đúng"
_BOX_WRONG   = (40,   40, 205)         # red   — "câu sai"
_BOX_FLAGGED = _BOX_REVIEW             # yellow — "câu lỗi" (multi/too-light/needs-review, any correctness)

# Text colours (BGR) for the big labels
_TXT_ON_GRAY    = (20,  20,  20)       # near-black on gray
_TXT_ON_COLORED = (15,  15,  15)       # near-black on coloured boxes


# ── Public API ────────────────────────────────────────────────────────────

def draw_template_overlay(
    image: np.ndarray,
    template: VJUTemplate,
    field_results: dict[str, FieldResult] | None = None,
    bubble_means: dict[str, float] | None = None,
    alpha: float = 0.60,
    draw_block_outlines: bool = True,
    draw_bubble_values: bool = True,
    draw_mean_values: bool = False,
    draw_mode: str = "both",
    block_expand_px: dict[str, int] | None = None,
    correctness: dict[str, bool] | None = None,
) -> np.ndarray:
    """
    Draw all bubble ROIs on the pageDimensions image.

    The image MUST already be resized to template.page_dimensions before calling.

    Args:
        image:            Grayscale or BGR image at pageDimensions resolution.
        template:         Parsed VJUTemplate.
        field_results:    Optional {field_label: FieldResult} — colours bubbles.
        bubble_means:     Optional {"label:value": mean_float} — shows intensity.
        alpha:            Overlay transparency (higher = more opaque shapes).
        draw_block_outlines: Draw purple outline around each block.
        draw_bubble_values:  Print A/B/C/D or 1..9,0 inside each bubble.
        draw_mean_values:    Print mean intensity number + fill_ratio below value.
        draw_mode:        "rect" | "circle" | "both"
                          rect   — rectangle ROI boundary only
                          circle — circle inscribed in ROI only
                          both   — rect + circle + center dot
        block_expand_px:  Optional {block_name: expand_px} — when set, draws the
                          actual expanded ROI used for measurement (not the nominal
                          bubble box). Green = detected, red = not detected.
        correctness:      Optional {field_label: is_correct} from the resolved
                          answer key — colors a clean ANSWERED bubble green/red
                          by correctness instead of always green (2026-08-03).

    Returns:
        BGR image with overlay.
    """
    if draw_mode not in DRAW_MODES:
        draw_mode = "both"

    # ── Ensure BGR ────────────────────────────────────────────────────────
    if len(image.shape) == 2:
        canvas = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    else:
        canvas = image.copy()

    # ── Auto-resize if caller forgot ──────────────────────────────────────
    expected_w, expected_h = template.page_dimensions
    actual_h, actual_w = canvas.shape[:2]
    if actual_w != expected_w or actual_h != expected_h:
        canvas = cv2.resize(canvas, (expected_w, expected_h), interpolation=cv2.INTER_LINEAR)

    overlay = canvas.copy()

    # ── Draw blocks ───────────────────────────────────────────────────────
    for block in template.field_blocks:
        expand_px = (block_expand_px or {}).get(block.name, 0)
        if draw_block_outlines:
            x1, y1, x2, y2 = bounding_box(block)
            cv2.rectangle(overlay, (x1, y1), (x2, y2), CLR_BLOCK_OUTLINE, 1)
            lbl = block.name if expand_px == 0 else f"{block.name} [+{expand_px}px]"
            cv2.putText(
                overlay, lbl,
                (x1, max(12, y1 - 4)),
                FONT, FONT_SCALE_VALUE * 1.4, CLR_BLOCK_LABEL, FONT_THICKNESS,
            )

        for bubble in block.bubbles:
            mean_key = f"{bubble.field_label}:{bubble.bubble_value}"
            mean_val = bubble_means.get(mean_key) if bubble_means else None
            color = _bubble_color(bubble, field_results, correctness)
            _draw_bubble(
                overlay, bubble, color,
                draw_bubble_values, draw_mean_values, mean_val,
                draw_mode, expand_px=expand_px,
            )

    # ── Blend ─────────────────────────────────────────────────────────────
    cv2.addWeighted(overlay, alpha, canvas, 1 - alpha, 0, canvas)

    # ── Post-blend: highlight selected / candidate bubbles ───────────────
    # Drawn AFTER the alpha-blend so they appear at full opacity.
    #
    # ANSWERED / MULTI_MARK → big semi-transparent box + large centered label
    # TOO_LIGHT / NEEDS_REVIEW → thin circle outline + small label?
    #   (candidates, not final answers — must look visually distinct)
    if field_results is not None:
        # NOTE: previously drew a "field:value(s)" text label above every
        # selected bubble (deduped to one per field), but even one label per
        # field cluttered dense multi-mark sheets — removed per user request.
        # The coloured highlight box/circle on each selected bubble already
        # shows what was read; text labels are still available in the
        # "marked_only" / "warnings" overlay variants if needed.
        for block in template.field_blocks:
            expand_px = (block_expand_px or {}).get(block.name, 0)
            for bubble in block.bubbles:
                result = field_results.get(bubble.field_label)
                if result is None or bubble.bubble_value not in result.selected_values:
                    continue

                is_int = result.field_type in _INT_FIELD_TYPES

                if result.status in _WARNING_CANDIDATE_STATUSES:
                    # Uncertain candidate — thin outline only, no big box
                    _draw_candidate_bubble_outline(
                        canvas, bubble, result.status, expand_px=expand_px,
                    )
                else:
                    # Confirmed answer (ANSWERED, MULTI_MARK, or INT variants)
                    _draw_selected_bubble_highlight(
                        canvas, bubble,
                        label_text=bubble.bubble_value,
                        status=result.status,
                        is_int=is_int,
                        expand_px=expand_px,
                        correctness=correctness,
                    )

    return canvas


# INT field types (used for colour logic)
_INT_FIELD_TYPES = {"QTYPE_INT_FROM_1", "QTYPE_INT"}


# ── Colour logic ──────────────────────────────────────────────────────────

def _bubble_color(
    bubble: BubbleSpec,
    field_results: dict[str, FieldResult] | None,
    correctness: dict[str, bool] | None = None,
) -> tuple[int, int, int]:
    """
    Args:
        correctness: Optional {field_label: is_correct}, built from the
            grading_report once an answer key resolved this sheet's mã đề
            (see engine.py's run_full_debug). Only affects a clean ANSWERED
            bubble's colour (green=đúng / red=sai); labels with no entry here
            (no key supplied, or a non-scored label like CCCD/SBD) keep the
            original green. TOO_LIGHT/MULTI_MARK/NEEDS_REVIEW always render as
            the single "câu lỗi" yellow regardless of correctness.
    """
    if field_results is None:
        return CLR_BUBBLE_DEFAULT

    result = field_results.get(bubble.field_label)
    if result is None:
        return CLR_BUBBLE_DEFAULT

    is_int = result.field_type in _INT_FIELD_TYPES

    if bubble.bubble_value in result.selected_values:
        if result.status == FieldStatus.ANSWERED:
            if correctness is not None and bubble.field_label in correctness:
                return CLR_BUBBLE_CORRECT if correctness[bubble.field_label] else CLR_BUBBLE_WRONG
            return CLR_BUBBLE_MARKED       # green  — clean single hit, no key
        elif result.status in (FieldStatus.TOO_LIGHT, FieldStatus.MULTI_MARK, FieldStatus.NEEDS_REVIEW):
            # Consolidated "câu lỗi" — flagged for manual review, regardless
            # of correctness (previously 3 distinct colours per sub-status).
            return CLR_BUBBLE_FLAGGED
        else:
            return CLR_BUBBLE_MARKED

    # Unselected bubble: dark gray for INT (makes unread digits obvious),
    # lighter gray for MCQ (less visual noise on large answer blocks).
    if is_int and result.status != FieldStatus.BLANK:
        return (100, 100, 100)  # slightly darker gray for unselected INT digits
    return CLR_BUBBLE_BLANK


# ── Shape drawing ─────────────────────────────────────────────────────────

def _draw_bubble(
    img: np.ndarray,
    bubble: BubbleSpec,
    color: tuple[int, int, int],
    draw_value: bool,
    draw_mean: bool,
    mean_val: float | None,
    draw_mode: str = "both",
    expand_px: int = 0,
) -> None:
    """Draw a bubble ROI with optional ROI expansion visualised.

    When expand_px > 0:
      - The nominal template box is drawn as a thin dashed-style outline (thin).
      - The actual expanded ROI used for reading is drawn in the status colour.
      - fill_ratio is shown alongside mean so it's easy to diagnose why a bubble
        failed detection.
    """
    x, y, w, h = bubble.x, bubble.y, bubble.w, bubble.h
    cx = x + w // 2
    cy = y + h // 2

    # Expanded dimensions (used for measurement and for drawing "actual read area")
    ex = expand_px
    rx = max(1, min(w + 2 * ex, h + 2 * ex) // 2)  # radius for expanded circle
    r  = max(1, min(w, h) // 2)                      # radius for nominal circle

    # ── Shape ─────────────────────────────────────────────────────────────
    if expand_px > 0:
        # Draw nominal bubble box as thin gray dashed reference
        if draw_mode in ("rect", "both"):
            cv2.rectangle(img, (x, y), (x + w, y + h), (180, 180, 180), 1)
        if draw_mode in ("circle", "both"):
            cv2.circle(img, (cx, cy), r, (180, 180, 180), 1)

        # Draw expanded ROI in status colour (this is what was actually read)
        if draw_mode in ("rect", "both"):
            cv2.rectangle(img, (x - ex, y - ex), (x + w + ex, y + h + ex), color, BUBBLE_LINE_WIDTH)
        if draw_mode in ("circle", "both"):
            cv2.circle(img, (cx, cy), rx, color, BUBBLE_LINE_WIDTH)
    else:
        # Normal (no expansion): draw nominal box in status colour
        if draw_mode in ("rect", "both"):
            cv2.rectangle(img, (x, y), (x + w, y + h), color, BUBBLE_LINE_WIDTH)
        if draw_mode in ("circle", "both"):
            cv2.circle(img, (cx, cy), r, color, BUBBLE_LINE_WIDTH)

    # Center dot (always in circle or both mode)
    if draw_mode in ("circle", "both"):
        cv2.circle(img, (cx, cy), 2, CLR_CENTER_DOT, -1)

    # ── Labels ────────────────────────────────────────────────────────────
    if draw_value:
        text = bubble.bubble_value
        (tw, th), _ = cv2.getTextSize(text, FONT, FONT_SCALE_VALUE, FONT_THICKNESS)
        tx = x + (w - tw) // 2
        # Push label up slightly if mean will also be shown below it
        has_stats = draw_mean and mean_val is not None
        ty = y + (h + th) // 2 - (h // 5 if has_stats else 0)
        cv2.putText(img, text, (tx, ty), FONT, FONT_SCALE_VALUE, CLR_VALUE_TEXT, FONT_THICKNESS)

    if draw_mean and mean_val is not None:
        fill = mean_val / 255.0
        # Show "mean/fill%" e.g. "187/0.73" — compact but informative
        mean_text = f"{int(mean_val)} f:{fill:.2f}"
        (mw, _mh), _ = cv2.getTextSize(mean_text, FONT, FONT_SCALE_MEAN, FONT_THICKNESS)
        mx = x + (w - mw) // 2
        my = y + h - 3
        cv2.putText(img, mean_text, (mx, my), FONT, FONT_SCALE_MEAN, CLR_MEAN_TEXT, FONT_THICKNESS)


# ── Overlay mode: marked_only ─────────────────────────────────────────────

def draw_overlay_marked_only(
    image: np.ndarray,
    template: VJUTemplate,
    field_results: dict[str, FieldResult],
    bubble_means: dict[str, float] | None = None,
    block_filter: str | None = None,
    block_expand_px: dict[str, int] | None = None,
) -> np.ndarray:
    """
    Draw ONLY bubbles that the machine considers MARKED (any non-blank status
    where the bubble value appears in selected_values).

    Visual style:
      - RED circle + RED rectangle
      - Label "field:value" drawn above the bubble (e.g. "toan2:C", "cccd3:4")
      - Mean intensity printed inside the circle (if bubble_means provided)
      - All blank / unselected bubbles are invisible → very clean readout

    Args:
        image:        Grayscale or BGR image at pageDimensions resolution.
        template:     Parsed VJUTemplate.
        field_results: {field_label: FieldResult} from OMR run.
        bubble_means: Optional {"label:value": float} — show intensity.
        block_filter: If set, only draw bubbles from this block name.

    Returns:
        BGR image.
    """
    canvas = _prepare_canvas(image, template)

    # ── Pass 1: collect selected bubbles grouped by field ─────────────────
    # field_label → (FieldResult, [BubbleSpec, ...]) ordered by template order
    from collections import OrderedDict
    field_map: dict[str, tuple[FieldResult, list]] = OrderedDict()
    for block in template.field_blocks:
        if block_filter and block.name != block_filter:
            continue
        for bubble in block.bubbles:
            result = field_results.get(bubble.field_label)
            if result is None or bubble.bubble_value not in result.selected_values:
                continue
            if bubble.field_label not in field_map:
                field_map[bubble.field_label] = (result, [])
            field_map[bubble.field_label][1].append(bubble)

    # ── Pass 2: draw each field's selected bubbles + one label per field ──
    for field_label, (result, bubbles) in field_map.items():
        # Status-based colour
        if result.status == FieldStatus.ANSWERED:
            border_clr = CLR_MARKED_OK
            label_clr  = CLR_MARKED_LABEL_OK
        elif result.status == FieldStatus.MULTI_MARK:
            border_clr = CLR_MARKED_MULTI
            label_clr  = CLR_MARKED_LABEL_MULTI
        elif result.status == FieldStatus.TOO_LIGHT:
            border_clr = CLR_MARKED_LIGHT
            label_clr  = CLR_MARKED_LABEL_WARN
        else:  # NEEDS_REVIEW etc.
            border_clr = CLR_MARKED_REVIEW
            label_clr  = CLR_MARKED_LABEL_WARN

        # Aggregate label: "field:A" for single, "field:A,C" for multi
        values_str = ",".join(result.selected_values)
        if result.status == FieldStatus.MULTI_MARK:
            label = f"{field_label}:{values_str} [multi]"
        elif result.status == FieldStatus.TOO_LIGHT:
            label = f"{field_label}:{values_str} [light]"
        elif result.status == FieldStatus.NEEDS_REVIEW:
            label = f"{field_label}:{values_str} [review]"
        else:
            label = f"{field_label}:{values_str}"

        # Find topmost bubble for label anchor
        topmost = min(bubbles, key=lambda b: b.y)
        label_cx = topmost.x + topmost.w // 2
        label_y  = max(12, topmost.y - 4)

        for bubble in bubbles:
            ex = (block_expand_px or {}).get(bubble.block_name, 0)
            is_int = result.field_type in _INT_FIELD_TYPES

            if result.status in _WARNING_CANDIDATE_STATUSES:
                # Uncertain candidate — thin outline only (not a final answer)
                _draw_candidate_bubble_outline(canvas, bubble, result.status, expand_px=ex)
            else:
                # Confirmed answer: big box + label
                _draw_selected_bubble_highlight(
                    canvas, bubble,
                    label_text=bubble.bubble_value,
                    status=result.status,
                    is_int=is_int,
                    expand_px=ex,
                )

        # One field:value label per field above the topmost bubble
        _draw_label_with_bg(canvas, label, label_cx, label_y, label_clr)

    return canvas


# ── Overlay mode: warnings ────────────────────────────────────────────────

def draw_overlay_warnings(
    image: np.ndarray,
    template: VJUTemplate,
    field_results: dict[str, FieldResult],
    bubble_means: dict[str, float] | None = None,
    block_filter: str | None = None,
    block_expand_px: dict[str, int] | None = None,
) -> np.ndarray:
    """
    Draw ONLY bubbles that triggered a warning:
      - MULTI_MARK  → orange circle + "field: A,C" candidates
      - TOO_LIGHT   → yellow circle + "field:value (light)"
      - NEEDS_REVIEW→ yellow-orange circle

    Each candidate bubble is drawn individually at its correct position.
    A summary text with all candidates is printed above the first bubble.

    Args:
        image:        BGR or gray image at pageDimensions resolution.
        template:     Parsed VJUTemplate.
        field_results: {field_label: FieldResult} from OMR run.
        bubble_means: Optional {"label:value": float}.
        block_filter: If set, only draw bubbles from this block name.

    Returns:
        BGR image.
    """
    canvas = _prepare_canvas(image, template)

    # ── Collect warning fields (multi/light/review) ───────────────────────
    # field_label → (result, first_bubble_of_field_in_template_order)
    from collections import OrderedDict
    WARNING_STATUSES = (FieldStatus.MULTI_MARK, FieldStatus.TOO_LIGHT, FieldStatus.NEEDS_REVIEW)
    BLANK_STATUSES   = (FieldStatus.BLANK,)

    warn_fields: dict[str, tuple[FieldResult, object]] = OrderedDict()  # field → (result, anchor_bubble)
    blank_fields: dict[str, tuple[FieldResult, object]] = OrderedDict()

    for block in template.field_blocks:
        if block_filter and block.name != block_filter:
            continue
        for bubble in block.bubbles:
            result = field_results.get(bubble.field_label)
            if result is None:
                continue
            fl = bubble.field_label
            if result.status in WARNING_STATUSES and fl not in warn_fields:
                warn_fields[fl] = (result, bubble)
            elif result.status in BLANK_STATUSES and fl not in blank_fields:
                blank_fields[fl] = (result, bubble)

    any_drawn = bool(warn_fields or blank_fields)

    # ── Draw warning bubbles ──────────────────────────────────────────────
    field_label_printed: set[str] = set()

    for block in template.field_blocks:
        if block_filter and block.name != block_filter:
            continue
        ex = (block_expand_px or {}).get(block.name, 0)
        for bubble in block.bubbles:
            result = field_results.get(bubble.field_label)
            if result is None or result.status not in WARNING_STATUSES:
                continue

            x, y, w, h = bubble.x, bubble.y, bubble.w, bubble.h
            cx = x + w // 2; cy = y + h // 2
            r     = max(1, min(w + 2 * ex, h + 2 * ex) // 2)
            r_nom = max(1, min(w, h) // 2)

            is_selected = bubble.bubble_value in result.selected_values

            if result.status == FieldStatus.MULTI_MARK:
                color = CLR_WARN_MULTI
            elif result.status == FieldStatus.TOO_LIGHT:
                color = CLR_WARN_LIGHT
            else:
                color = CLR_WARN_REVIEW

            if is_selected:
                is_int = result.field_type in _INT_FIELD_TYPES
                # Warning overlay: candidates → thin outline (not big box)
                # MULTI_MARK on INT → big box (it IS the final reading for INT)
                if result.status in _WARNING_CANDIDATE_STATUSES:
                    _draw_candidate_bubble_outline(canvas, bubble, result.status, expand_px=ex)
                else:
                    _draw_selected_bubble_highlight(
                        canvas, bubble,
                        label_text=bubble.bubble_value,
                        status=result.status,
                        is_int=is_int,
                        expand_px=ex,
                    )
            else:
                # Light gray outline for context bubbles (not selected)
                cv2.circle(canvas, (cx, cy), r, (190, 190, 190), 1)

            # One label per field, above first bubble of this field
            if bubble.field_label not in field_label_printed and is_selected:
                field_label_printed.add(bubble.field_label)
                candidates = ",".join(result.selected_values)
                status_tag = {
                    FieldStatus.MULTI_MARK:   "multi",
                    FieldStatus.TOO_LIGHT:    "light",
                    FieldStatus.NEEDS_REVIEW: "review",
                }.get(result.status, "warn")
                summary = f"{bubble.field_label}: {candidates} [{status_tag}]"
                _draw_label_with_bg(canvas, summary, cx, max(12, y - 4), CLR_WARN_LABEL)

    # ── Draw blank field labels (gray, smaller) ───────────────────────────
    for fl, (result, anchor) in blank_fields.items():
        bub = anchor  # type: ignore[assignment]
        x, y, w, _h = bub.x, bub.y, bub.w, bub.h  # type: ignore[union-attr]
        cx = x + w // 2
        summary = f"{fl}: [blank]"
        _draw_label_with_bg(canvas, summary, cx, max(12, y - 4),
                             (120, 120, 120), font_scale=FONT_SCALE_LABEL * 0.9)

    # ── Fallback message if nothing to show ───────────────────────────────
    if not any_drawn:
        msg = "No warnings detected"
        (mw, _mh), _ = cv2.getTextSize(msg, FONT, 0.8, 2)
        ih, iw = canvas.shape[:2]
        cv2.putText(canvas, msg, ((iw - mw) // 2, ih // 2), FONT, 0.8, (0, 160, 0), 2)

    return canvas


# ── Internal helpers ──────────────────────────────────────────────────────

def _draw_semi_transparent_rect(
    img: np.ndarray,
    x1: int, y1: int, x2: int, y2: int,
    color: tuple[int, int, int],
    alpha: float,
) -> None:
    """Alpha-blend a filled rectangle onto img in-place (no external canvas needed)."""
    x1 = max(0, x1);  y1 = max(0, y1)
    x2 = min(img.shape[1], x2);  y2 = min(img.shape[0], y2)
    if x2 <= x1 or y2 <= y1:
        return
    roi = img[y1:y2, x1:x2]
    colored = np.full_like(roi, color, dtype=np.uint8)
    img[y1:y2, x1:x2] = cv2.addWeighted(colored, alpha, roi, 1.0 - alpha, 0)


def _draw_candidate_bubble_outline(
    img: np.ndarray,
    bubble: "BubbleSpec",
    status: "FieldStatus",
    expand_px: int = 0,
) -> None:
    """
    Draw a thin circle outline + small label+? for WARNING CANDIDATES.

    Used for TOO_LIGHT and NEEDS_REVIEW bubbles that are uncertain — they
    are NOT final answers and should look visually distinct from confirmed
    selections.  No big box, no solid fill — just a thin coloured ring
    and a small label with a ? suffix.

    Colour:
        TOO_LIGHT    → orange thin circle
        NEEDS_REVIEW → amber thin circle
    """
    x, y, w, h = bubble.x, bubble.y, bubble.w, bubble.h
    cx = x + w // 2
    cy = y + h // 2
    ex  = expand_px
    r   = max(1, min(w + 2 * ex, h + 2 * ex) // 2)

    if status == FieldStatus.TOO_LIGHT:
        color = (0, 120, 255)    # orange (BGR)
    else:                        # NEEDS_REVIEW
        color = (0, 165, 255)    # amber (BGR)

    # Thin dashed-style circle (2 separate arcs to suggest dashes)
    cv2.circle(img, (cx, cy), r, color, 1, lineType=cv2.LINE_AA)

    # Small label with "?" appended
    label = f"{bubble.bubble_value}?"
    fs = FONT_SCALE_VALUE * 0.80
    (tw, th), _ = cv2.getTextSize(label, FONT, fs, 1)
    cv2.putText(
        img, label,
        (cx - tw // 2, cy + th // 2),
        FONT, fs, color, 1, cv2.LINE_AA,
    )


# ── Warning-candidate statuses — these must NOT get the big selection box ─
_WARNING_CANDIDATE_STATUSES = (FieldStatus.TOO_LIGHT, FieldStatus.NEEDS_REVIEW)


def _draw_selected_bubble_highlight(
    img: np.ndarray,
    bubble: "BubbleSpec",
    label_text: str,
    status: "FieldStatus",
    is_int: bool = False,
    expand_px: int = 0,
    pad: int = SELECTED_BOX_PADDING,
    box_alpha: float = SELECTED_BOX_ALPHA,
    correctness: dict[str, bool] | None = None,
) -> None:
    """
    New-style selected-bubble rendering:

    1. Semi-transparent coloured box (box_alpha) covering bubble + padding.
    2. Thin solid border around the box in a darker shade of the fill.
    3. Big centered label (A/B/C/D or digit) — font scales with bubble width.

    Status → fill colour mapping:
      ANSWERED        → green/red by correctness (if `correctness` has this
                         label), else gray (no answer key supplied)
      MULTI_MARK / TOO_LIGHT / NEEDS_REVIEW → single "câu lỗi" yellow,
                         regardless of correctness (2026-08-03; previously 3
                         different colours per sub-status)

    Args:
        correctness: Optional {field_label: is_correct} — see _bubble_color.
    """
    x, y, w, h = bubble.x, bubble.y, bubble.w, bubble.h
    cx = x + w // 2
    cy = y + h // 2

    # ── Box colour ────────────────────────────────────────────────────────
    if status == FieldStatus.ANSWERED:
        if correctness is not None and bubble.field_label in correctness:
            box_clr = _BOX_CORRECT if correctness[bubble.field_label] else _BOX_WRONG
            txt_clr = _TXT_ON_COLORED
        else:
            box_clr = _BOX_ANSWERED
            txt_clr = _TXT_ON_GRAY
    elif status in (FieldStatus.MULTI_MARK, FieldStatus.TOO_LIGHT, FieldStatus.NEEDS_REVIEW):
        box_clr = _BOX_FLAGGED
        txt_clr = _TXT_ON_COLORED
    else:
        box_clr = _BOX_DEFAULT
        txt_clr = _TXT_ON_GRAY

    # ── Box coords ────────────────────────────────────────────────────────
    bx1 = x - expand_px - pad
    by1 = y - expand_px - pad
    bx2 = x + w + expand_px + pad
    by2 = y + h + expand_px + pad

    # 1. Semi-transparent fill
    _draw_semi_transparent_rect(img, bx1, by1, bx2, by2, box_clr, box_alpha)

    # 2. Solid border (slightly darker than fill)
    border_clr = tuple(max(0, int(c) - 50) for c in box_clr)
    cv2.rectangle(img, (bx1, by1), (bx2, by2), border_clr, 1)  # type: ignore[arg-type]

    # ── Big centered text ─────────────────────────────────────────────────
    # Font scale proportional to bubble width so it looks right at any resolution.
    font_scale = max(0.55, w / 32.0 * SELECTED_LABEL_FONT_SCALE_BASE)
    thickness  = SELECTED_LABEL_THICKNESS
    (tw, th), _ = cv2.getTextSize(label_text, FONT, font_scale, thickness)
    tx = cx - tw // 2
    ty = cy + th // 2
    cv2.putText(img, label_text, (tx, ty), FONT, font_scale, txt_clr, thickness, cv2.LINE_AA)


def _prepare_canvas(image: np.ndarray, template: VJUTemplate) -> np.ndarray:
    """Ensure BGR, correct size."""
    if len(image.shape) == 2:
        canvas = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    else:
        canvas = image.copy()
    expected_w, expected_h = template.page_dimensions
    ah, aw = canvas.shape[:2]
    if aw != expected_w or ah != expected_h:
        canvas = cv2.resize(canvas, (expected_w, expected_h), interpolation=cv2.INTER_LINEAR)
    return canvas


def _draw_label_with_bg(
    img: np.ndarray,
    text: str,
    cx: int,
    bottom_y: int,
    color: tuple[int, int, int],
    font_scale: float = FONT_SCALE_LABEL,
    thickness: int = FONT_THICKNESS_BOLD,
    bg_pad: int = 2,
) -> None:
    """Draw text with white background pill, centered horizontally at cx, text baseline at bottom_y."""
    (tw, th), _ = cv2.getTextSize(text, FONT, font_scale, thickness)
    lx = max(0, cx - tw // 2)
    ly = max(th + bg_pad + 1, bottom_y)
    cv2.rectangle(img,
                  (lx - bg_pad, ly - th - bg_pad),
                  (lx + tw + bg_pad, ly + bg_pad),
                  (255, 255, 255), -1)
    cv2.putText(img, text, (lx, ly), FONT, font_scale, color, thickness)


# ── Projected overlay (Phase 2 — inverse-H mode) ─────────────────────────

def draw_overlay_projected(
    image: np.ndarray,
    template: VJUTemplate,
    M_inv: np.ndarray,
    field_results: dict[str, FieldResult] | None = None,
    bubble_means: dict[str, float] | None = None,
    alpha: float = 0.60,
    draw_block_outlines: bool = True,
    draw_mean_values: bool = False,
    block_expand_px: dict[str, int] | None = None,
    correctness: dict[str, bool] | None = None,
) -> np.ndarray:
    """
    Draw bubble ROI overlays on the *original* (non-warped) image by projecting
    template-space bubble coordinates into image space via M_inv.

    Used in inverse-H mode (scan_app, Phase 2) so the detect overlay is drawn
    on the non-distorted image rather than on the stretched warp output.

    Args:
        image:     Grayscale or BGR original image (NOT pageDimensions-sized).
        template:  Parsed VJUTemplate.
        M_inv:     3×3 inverse homography — maps template coords → original image.
        field_results, bubble_means: same semantics as draw_template_overlay.
        alpha:     Overlay blend alpha.
        draw_block_outlines: Draw projected block bounding rectangles (as quads).
        draw_mean_values:    Print mean intensity at projected bubble center.
        block_expand_px:     {block_name: expand_px} expansion offsets.

    Returns:
        BGR image at same resolution as `image` input.
    """
    # Prepare BGR canvas at original image size (NOT pageDimensions)
    if len(image.shape) == 2:
        canvas = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    else:
        canvas = image.copy()

    overlay = canvas.copy()
    img_h, img_w = canvas.shape[:2]

    def _proj(pts_template: np.ndarray) -> np.ndarray:
        """Project (N,2) template points → (N,2) image points via M_inv."""
        shaped = pts_template.astype("float32").reshape(1, -1, 2)
        projected = cv2.perspectiveTransform(shaped, M_inv).reshape(-1, 2)
        projected[:, 0] = np.clip(projected[:, 0], 0, img_w - 1)
        projected[:, 1] = np.clip(projected[:, 1], 0, img_h - 1)
        return projected.astype(np.int32)

    # ── Draw block outlines (projected as quads) ──────────────────────────
    if draw_block_outlines:
        for block in template.field_blocks:
            x1, y1, x2, y2 = bounding_box(block)
            corners_tpl = np.array([[x1, y1], [x2, y1], [x2, y2], [x1, y2]], dtype="float32")
            corners_img = _proj(corners_tpl)
            cv2.polylines(overlay, [corners_img], True, CLR_BLOCK_OUTLINE, 1)

    # ── Draw bubbles ──────────────────────────────────────────────────────
    for block in template.field_blocks:
        expand_px = (block_expand_px or {}).get(block.name, 0)
        for bubble in block.bubbles:
            x, y, w, h = bubble.x, bubble.y, bubble.w, bubble.h
            ex = expand_px

            # Project bubble center and corner points
            cx_tpl = x + w / 2.0
            cy_tpl = y + h / 2.0
            center_tpl = np.array([[cx_tpl, cy_tpl]], dtype="float32")
            center_img = _proj(center_tpl)[0]

            # Estimate radius by projecting a point at distance r from center
            r_tpl = max(1, min(w + 2 * ex, h + 2 * ex) // 2)
            edge_tpl = np.array([[cx_tpl + r_tpl, cy_tpl]], dtype="float32")
            edge_img = _proj(edge_tpl)[0]
            r_img = max(2, int(np.linalg.norm(edge_img - center_img)))

            color = _bubble_color(bubble, field_results, correctness)
            cx_i, cy_i = int(center_img[0]), int(center_img[1])

            # Draw projected circle
            cv2.circle(overlay, (cx_i, cy_i), r_img, color, BUBBLE_LINE_WIDTH)
            cv2.circle(overlay, (cx_i, cy_i), 2, CLR_CENTER_DOT, -1)

            # Mean value text at projected center
            if draw_mean_values and bubble_means is not None:
                mean_key = f"{bubble.field_label}:{bubble.bubble_value}"
                mean_val = bubble_means.get(mean_key)
                if mean_val is not None:
                    fill = mean_val / 255.0
                    mean_text = f"{int(mean_val)} f:{fill:.2f}"
                    cv2.putText(
                        overlay, mean_text,
                        (max(0, cx_i - 20), cy_i + 4),
                        FONT, FONT_SCALE_MEAN, CLR_MEAN_TEXT, FONT_THICKNESS,
                    )

    # ── Blend ─────────────────────────────────────────────────────────────
    cv2.addWeighted(overlay, alpha, canvas, 1 - alpha, 0, canvas)

    # ── Post-blend: field:value labels for marked bubbles ─────────────────
    if field_results is not None:
        for block in template.field_blocks:
            for bubble in block.bubbles:
                result = field_results.get(bubble.field_label)
                if result is None or bubble.bubble_value not in result.selected_values:
                    continue

                x, y, w, h = bubble.x, bubble.y, bubble.w, bubble.h
                center_img = _proj(np.array([[x + w / 2.0, y + h / 2.0]], dtype="float32"))[0]
                cx_i = int(center_img[0])
                cy_i = int(center_img[1])

                if result.status == FieldStatus.ANSWERED:
                    lclr = CLR_MARKED_LABEL_OK
                elif result.status == FieldStatus.MULTI_MARK:
                    lclr = CLR_MARKED_LABEL_MULTI
                else:
                    lclr = CLR_MARKED_LABEL_WARN

                label = f"{bubble.field_label}:{bubble.bubble_value}"
                _draw_label_with_bg(canvas, label, cx_i, max(12, cy_i - 2), lclr)

    return canvas


# ── Section score summary (2026-08-06) ────────────────────────────────────
# In tóm tắt điểm từng "Phần" (P1/P2/P3...) + tổng điểm lên góc ảnh overlay,
# kiểu chấm bằng bút đỏ — dùng scorer.GradingReport.sections (đã tính sẵn
# theo đúng điểm từng câu đặt ở "Thang điểm"/AnswerKeyPage). Không import
# GradingReport ở đây để tránh phụ thuộc vòng (debug_overlay ← engine ←
# scorer) — nhận thẳng `sections`/`total_score`/`max_score` đã tính xong.
#
# Dùng PIL (không phải cv2.putText) để vẽ — font Hershey mặc định của OpenCV
# vừa xấu (răng cưa, không có nét thanh/đậm) vừa KHÔNG vẽ được dấu tiếng Việt
# (từng phải viết "Tong" thay vì "Tổng" vì lý do này). PIL vẽ được font
# TrueType thật + đủ dấu, khớp đúng font "Be Vietnam Pro" web đang dùng
# (frontend/index.html) nếu có sẵn file — xem _resolve_score_font().
try:
    from PIL import Image as _PILImage, ImageDraw as _PILImageDraw, ImageFont as _PILImageFont
    _PIL_AVAILABLE = True
except ModuleNotFoundError:
    _PIL_AVAILABLE = False

CLR_SCORE_TEXT = (0, 0, 220)   # đỏ (BGR) — giống mực chấm bài
CLR_SCORE_BG   = (255, 255, 255)

# "Phần I-II" → "P1", "Phần III" → "P2", "Phần IV" → "P3"... — thứ tự cố định
# theo đúng thứ tự vật lý trên phiếu (I-II trước, rồi III, rồi IV), không
# phải thứ tự dict trả về (dict không đảm bảo giữ thứ tự chèn qua nhiều bước).
_PHAN_ORDER = ["Phần I-II", "Phần III", "Phần IV"]
_PHAN_SHORT = {"Phần I-II": "P1", "Phần III": "P2", "Phần IV": "P3"}

# Thứ tự ưu tiên tìm font: (1) font bundle sẵn trong repo — thả file
# "Be Vietnam Pro Bold" (hoặc bất kỳ .ttf nào) vào đây để khớp CHÍNH XÁC font
# web đang dùng (tải tại https://fonts.google.com/specimen/Be+Vietnam+Pro →
# Download family → lấy file "BeVietnamPro-Bold.ttf" → đổi tên đúng thành
# "score_summary.ttf" → bỏ vào backend/app/core/omr/assets/fonts/); (2) vài
# font hệ thống macOS/Linux phổ biến có đủ dấu tiếng Việt, phòng khi chưa có
# bước (1); (3) font bitmap mặc định của PIL (luôn có sẵn, xấu nhưng không
# bao giờ lỗi) — đảm bảo tính năng vẫn chạy được ngay cả khi thiếu mọi font.
_BUNDLED_FONT_PATH = Path(__file__).resolve().parent / "assets" / "fonts" / "score_summary.ttf"
_FALLBACK_FONT_CANDIDATES = [
    "/System/Library/Fonts/SFNS.ttf",                              # macOS — San Francisco (hệ thống)
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",         # macOS cũ — phủ Unicode rộng
    "/System/Library/Fonts/HelveticaNeue.ttc",                      # macOS
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",         # Linux (sandbox dev)
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",  # Linux
]

_score_font_cache: dict[int, "object"] = {}


def _resolve_score_font(size: int):
    """Trả về PIL ImageFont phù hợp nhất tìm được, cache theo size."""
    if size in _score_font_cache:
        return _score_font_cache[size]
    candidates = [str(_BUNDLED_FONT_PATH), *_FALLBACK_FONT_CANDIDATES]
    font = None
    for path in candidates:
        if Path(path).exists():
            try:
                font = _PILImageFont.truetype(path, size=size)
                break
            except Exception:
                continue
    if font is None:
        font = _PILImageFont.load_default()
    _score_font_cache[size] = font
    return font


def draw_section_score_summary(
    image: np.ndarray,
    sections: dict[str, "object"],   # dict[str, scorer.SectionScore], xem ghi chú trên
    total_score: float,
    max_score: float,
    origin: tuple[int, int] = (18, 34),
    line_height: int = 38,
    font_size: int = 30,
) -> np.ndarray:
    """
    Vẽ text kiểu:
        P1: 32/40 = 3.20
        P2: 4/4; 4/4; 0/4; 2/4 = 2.25
        P3: 5/6 = 1.80
        Tổng: 7.25
    lên góc trên-trái `image` (đã copy, không sửa ảnh gốc), dùng font
    TrueType thật (xem _resolve_score_font) thay vì font cv2 mặc định. Bỏ
    qua nếu `sections` rỗng (template không khớp quy ước Phần nào đã biết)
    hoặc thiếu thư viện Pillow.
    """
    if not sections or not _PIL_AVAILABLE:
        return image

    lines: list[str] = []
    ordered_names = [n for n in _PHAN_ORDER if n in sections] + [
        n for n in sections if n not in _PHAN_ORDER
    ]
    for name in ordered_names:
        sec = sections[name]
        short = _PHAN_SHORT.get(name, name)
        lines.append(f"{short}: {sec.correct}/{sec.total} = {sec.points_earned:.2f}")
    lines.append(f"Tổng: {total_score:.2f}/{max_score:.2f}")

    font = _resolve_score_font(font_size)

    # cv2 (numpy BGR) → PIL (RGB) để vẽ chữ, rồi chuyển ngược lại.
    pil_img = _PILImage.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))
    draw = _PILImageDraw.Draw(pil_img)

    x, y = origin
    max_tw = max(draw.textlength(t, font=font) for t in lines)
    pad = 12
    box_h = line_height * len(lines) + pad

    # Nền trắng mờ phía sau cho dễ đọc trên nền phiếu, rồi mới vẽ chữ đỏ đè lên.
    overlay = pil_img.copy()
    overlay_draw = _PILImageDraw.Draw(overlay)
    overlay_draw.rectangle(
        (x - pad, y - pad, x + max_tw + pad, y - pad + box_h),
        fill=(255, 255, 255),
    )
    pil_img = _PILImage.blend(pil_img, overlay, 0.75)
    draw = _PILImageDraw.Draw(pil_img)

    text_color_rgb = (CLR_SCORE_TEXT[2], CLR_SCORE_TEXT[1], CLR_SCORE_TEXT[0])
    for i, text in enumerate(lines):
        draw.text((x, y + i * line_height), text, font=font, fill=text_color_rgb)

    return cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)


# ── Save ─────────────────────────────────────────────────────────────────

def save_overlay(
    overlay: np.ndarray,
    output_path: str | Path,
    quality: int = 92,
) -> Path:
    """Save overlay image to disk, creating parent dirs as needed."""
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    ext = out.suffix.lower()
    if ext in (".jpg", ".jpeg"):
        cv2.imwrite(str(out), overlay, [cv2.IMWRITE_JPEG_QUALITY, quality])
    else:
        cv2.imwrite(str(out), overlay)
    return out
