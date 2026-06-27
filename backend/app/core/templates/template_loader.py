"""
template_loader.py
==================
Load and parse the VJU OMR template JSON.

Key conventions (verified from OMRChecker source):
- origin = [x, y] = TOP-LEFT corner of the FIRST bubble in the block
- QTYPE_INT_FROM_1: direction=vertical
    - bubbles go DOWN   (bubblesGap applied to y)
    - labels  go RIGHT  (labelsGap  applied to x)
    - bubbleValues = ["1","2","3","4","5","6","7","8","9","0"]
- QTYPE_MCQ4: direction=horizontal
    - bubbles go RIGHT  (bubblesGap applied to x)
    - labels  go DOWN   (labelsGap  applied to y)
    - bubbleValues = ["A","B","C","D"]
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# ── Field-type definitions (mirrors OMRChecker FIELD_TYPES) ──────────────
FIELD_TYPES: dict[str, dict[str, Any]] = {
    "QTYPE_INT_FROM_1": {
        "bubbleValues": ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
        "direction": "vertical",
    },
    "QTYPE_INT": {
        "bubbleValues": ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
        "direction": "vertical",
    },
    "QTYPE_MCQ4": {
        "bubbleValues": ["A", "B", "C", "D"],
        "direction": "horizontal",
    },
    "QTYPE_MCQ5": {
        "bubbleValues": ["A", "B", "C", "D", "E"],
        "direction": "horizontal",
    },
}

# Regex for range strings like "cccd1..12", "toan1..15".
# Also handles "cccd1..cccd12" (repeated prefix) for backward compatibility
# with area JSONs saved by older frontend versions.
_RANGE_REGEX = re.compile(r"([^\d.]+)(\d+)\.{2,3}(?:[^\d.]+)?(\d+)")


# ── Data-classes ──────────────────────────────────────────────────────────

@dataclass
class BubbleSpec:
    """Coordinates + metadata for a single bubble."""
    field_label: str       # e.g. "cccd3", "toan7"
    bubble_value: str      # e.g. "5", "A"
    x: int                 # top-left x (column) on page
    y: int                 # top-left y (row)    on page
    w: int                 # bubble width  (px at pageDimensions resolution)
    h: int                 # bubble height (px)
    field_type: str        # "QTYPE_INT_FROM_1" | "QTYPE_MCQ4" | …
    block_name: str        # parent block name for diagnostics


@dataclass
class FieldBlockSpec:
    name: str
    field_type: str
    direction: str
    bubble_values: list[str]
    origin: list[int]       # [x, y] top-left of first bubble
    bubbles_gap: int        # distance between bubble top-lefts along bubble axis
    labels_gap: int         # distance between field top-lefts along label axis
    field_labels: list[str]
    bubble_dimensions: list[int]   # [width, height]
    bubbles: list[BubbleSpec] = field(default_factory=list)
    # ROI expansion: expand read area by this many pixels on each side (center kept fixed)
    # Safe range: <= (bubblesGap - bubbleDim) // 2 - 1  to avoid bleeding into neighbours
    roi_expand_px: int = 0


@dataclass
class VJUTemplate:
    path: Path
    page_dimensions: list[int]        # [width, height]
    default_bubble_dimensions: list[int]
    field_blocks: list[FieldBlockSpec]
    custom_labels: dict[str, list[str]]
    # Mapping: field_label → list of BubbleSpec (in bubble_value order)
    bubbles_by_label: dict[str, list[BubbleSpec]] = field(default_factory=dict)
    # All expanded label names across all blocks
    all_labels: list[str] = field(default_factory=list)
    # Optional: marker center positions in template coordinate space.
    # Keys: "TL","TR","BR","BL" → [x, y].
    # When present, used by CropOnMarkers to compute the correct perspective
    # transform (marker centers → template positions) instead of the legacy
    # inner-corner-to-page-corner warp.
    marker_centers_in_template: dict[str, list[int]] | None = None
    # Optional: per-image-source override for marker center positions.
    # Keys: image_source (e.g. "scan_app", "flatbed") → same TL/TR/BR/BL dict.
    # When the runtime image_source matches a key here, that set of positions
    # is used instead of marker_centers_in_template.
    marker_centers_by_source: dict[str, dict[str, list[int]]] | None = None


# ── Public API ────────────────────────────────────────────────────────────

def load_template(template_path: str | Path) -> VJUTemplate:
    """Load, expand and return a VJUTemplate from a JSON file."""
    path = Path(template_path)
    if not path.exists():
        raise FileNotFoundError(f"Template not found: {path}")

    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    page_dimensions = raw["pageDimensions"]            # [width, height]
    default_bubble_dim = raw.get("bubbleDimensions", [40, 40])
    custom_labels_raw = raw.get("customLabels", {})
    field_blocks_raw = raw.get("fieldBlocks", {})
    # Global default ROI expansion (can be overridden per block via "roiExpandPx")
    global_roi_expand_px: int = int(raw.get("roiExpandPx", 0))

    # Parse optional cropOnMarkersConfig
    crop_cfg = raw.get("cropOnMarkersConfig", {})
    marker_centers_raw = crop_cfg.get("markerCentersInTemplate")
    marker_centers_in_template: dict[str, list[int]] | None = None
    if marker_centers_raw and all(
        k in marker_centers_raw for k in ("TL", "TR", "BR", "BL")
    ):
        marker_centers_in_template = {
            k: [int(v[0]), int(v[1])] for k, v in marker_centers_raw.items()
        }

    # Parse per-source overrides: markerCentersInTemplateBySource
    marker_centers_by_source: dict[str, dict[str, list[int]]] | None = None
    by_source_raw = crop_cfg.get("markerCentersInTemplateBySource", {})
    if by_source_raw:
        parsed: dict[str, dict[str, list[int]]] = {}
        for src_key, centers in by_source_raw.items():
            if centers and all(k in centers for k in ("TL", "TR", "BR", "BL")):
                parsed[src_key] = {
                    k: [int(v[0]), int(v[1])] for k, v in centers.items()
                }
        if parsed:
            marker_centers_by_source = parsed

    # Expand customLabels range strings
    custom_labels: dict[str, list[str]] = {}
    for key, strings in custom_labels_raw.items():
        custom_labels[key] = _expand_labels(strings)

    # Parse field blocks
    field_blocks: list[FieldBlockSpec] = []
    all_labels: list[str] = []
    bubbles_by_label: dict[str, list[BubbleSpec]] = {}

    for block_name, block_raw in field_blocks_raw.items():
        spec = _parse_field_block(
            block_name, block_raw, default_bubble_dim, page_dimensions,
            global_roi_expand_px=global_roi_expand_px,
        )
        field_blocks.append(spec)
        all_labels.extend(spec.field_labels)

        for bubble in spec.bubbles:
            bubbles_by_label.setdefault(bubble.field_label, []).append(bubble)

    template = VJUTemplate(
        path=path,
        page_dimensions=page_dimensions,
        default_bubble_dimensions=default_bubble_dim,
        field_blocks=field_blocks,
        custom_labels=custom_labels,
        bubbles_by_label=bubbles_by_label,
        all_labels=all_labels,
        marker_centers_in_template=marker_centers_in_template,
        marker_centers_by_source=marker_centers_by_source,
    )
    return template


# ── Label range expansion ─────────────────────────────────────────────────

def expand_label_string(label_string: str) -> list[str]:
    """
    Expand a single label string.
    "cccd1..12" → ["cccd1", "cccd2", ..., "cccd12"]
    "toan1"     → ["toan1"]
    """
    m = _RANGE_REGEX.fullmatch(label_string.strip())
    if m:
        prefix, start, end = m.group(1), int(m.group(2)), int(m.group(3))
        if start >= end:
            raise ValueError(
                f"Invalid label range '{label_string}': start ({start}) must be < end ({end})"
            )
        return [f"{prefix}{i}" for i in range(start, end + 1)]
    return [label_string.strip()]


def _expand_labels(label_strings: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for s in label_strings:
        expanded = expand_label_string(s)
        for lbl in expanded:
            if lbl in seen:
                raise ValueError(f"Duplicate label '{lbl}' in {label_strings}")
            seen.add(lbl)
            result.append(lbl)
    return result


# ── Field block parsing ───────────────────────────────────────────────────

def _parse_field_block(
    block_name: str,
    raw: dict,
    default_bubble_dim: list[int],
    page_dimensions: list[int],
    global_roi_expand_px: int = 0,
) -> FieldBlockSpec:
    field_type = raw["fieldType"]
    if field_type not in FIELD_TYPES:
        raise ValueError(f"Unknown fieldType '{field_type}' in block '{block_name}'")

    type_defaults = FIELD_TYPES[field_type]
    direction: str = raw.get("direction", type_defaults["direction"])
    bubble_values: list[str] = raw.get("bubbleValues", type_defaults["bubbleValues"])
    origin: list[int] = raw["origin"]
    bubbles_gap: int = raw["bubblesGap"]
    labels_gap: int = raw["labelsGap"]
    bubble_dim: list[int] = raw.get("bubbleDimensions", default_bubble_dim)
    field_labels: list[str] = _expand_labels(raw["fieldLabels"])
    # Per-block ROI expansion (falls back to global template default)
    roi_expand_px: int = int(raw.get("roiExpandPx", global_roi_expand_px))

    # Generate all bubbles
    bubbles = _generate_bubbles(
        block_name=block_name,
        field_type=field_type,
        direction=direction,
        bubble_values=bubble_values,
        origin=origin,
        bubbles_gap=bubbles_gap,
        labels_gap=labels_gap,
        bubble_dim=bubble_dim,
        field_labels=field_labels,
        page_dimensions=page_dimensions,
    )

    return FieldBlockSpec(
        name=block_name,
        field_type=field_type,
        direction=direction,
        bubble_values=bubble_values,
        origin=origin,
        bubbles_gap=bubbles_gap,
        labels_gap=labels_gap,
        field_labels=field_labels,
        bubble_dimensions=bubble_dim,
        bubbles=bubbles,
        roi_expand_px=roi_expand_px,
    )


def _generate_bubbles(
    *,
    block_name: str,
    field_type: str,
    direction: str,
    bubble_values: list[str],
    origin: list[int],
    bubbles_gap: int,
    labels_gap: int,
    bubble_dim: list[int],
    field_labels: list[str],
    page_dimensions: list[int],
) -> list[BubbleSpec]:
    """
    Generate BubbleSpec list using the same algorithm as OMRChecker.

    direction="vertical"  (INT types):
        _h=1 (y axis) → bubbles go DOWN   (y += bubblesGap per value)
        _v=0 (x axis) → labels  go RIGHT  (x += labelsGap  per label)

    direction="horizontal" (MCQ types):
        _h=0 (x axis) → bubbles go RIGHT  (x += bubblesGap per value)
        _v=1 (y axis) → labels  go DOWN   (y += labelsGap  per label)
    """
    if direction == "vertical":
        _h, _v = 1, 0   # h=y, v=x
    else:
        _h, _v = 0, 1   # h=x, v=y

    w, h = bubble_dim[0], bubble_dim[1]
    page_w, page_h = page_dimensions

    bubbles: list[BubbleSpec] = []
    lead = [float(origin[0]), float(origin[1])]

    for label in field_labels:
        pt = lead.copy()
        for value in bubble_values:
            bx, by = int(round(pt[0])), int(round(pt[1]))
            # Bounds check
            if bx < 0 or by < 0 or bx + w > page_w or by + h > page_h:
                raise ValueError(
                    f"Bubble ({bx},{by},{w},{h}) out of page bounds "
                    f"[{page_w}x{page_h}] in block '{block_name}', "
                    f"label '{label}', value '{value}'"
                )
            bubbles.append(BubbleSpec(
                field_label=label,
                bubble_value=value,
                x=bx, y=by, w=w, h=h,
                field_type=field_type,
                block_name=block_name,
            ))
            pt[_h] += bubbles_gap
        lead[_v] += labels_gap

    return bubbles
