"""
template_compiler.py
====================
Compile a list of area definitions into an OMR-compatible template JSON dict.

Ported from vju-omr-web/backend/core/template_builder.py (relevant subset).
No FastAPI or HTTP dependency — raises ValueError/CompileError on invalid input
so callers can wrap into HTTP responses as needed.

Public API
----------
    compile_template(areas, page_dimensions, use_crop_on_markers) -> dict
    build_preview_field_block(area) -> tuple[str, dict, list[str]]
    build_preview_grid_fallback(block_name, field_block, page_w, page_h, warnings) -> dict
    extract_answer_fields_from_template(template, areas) -> list[dict]
    autofit_geometry_from_box(area, *, direction, field_type, physical_rows, physical_cols) -> dict
"""

from __future__ import annotations

import math
import re
from typing import Any

import numpy as np

from app.core.templates.template_loader import expand_label_string

# ── Public re-exports (constants) ──────────────────────────────────────────────

DEFAULT_PAGE_SIZE: tuple[int, int] = (1000, 1414)

MARKER_PREPROCESSOR: dict = {
    "name": "CropOnMarkers",
    "options": {
        "relativePath": "omr_marker.jpg",
        "sheetToMarkerWidthRatio": 17,
        "min_matching_threshold": 0.27,
        "max_matching_variation": 0.45,
        "marker_rescale_range": [20, 150],
    },
}

# Values (bubble labels) per fieldType
FIELD_TYPE_VALUES: dict[str, list[str]] = {
    "QTYPE_INT":          ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
    "QTYPE_INT_FROM_1":   ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
    "QTYPE_MCQ4":         ["A", "B", "C", "D"],
    "QTYPE_MCQ5":         ["A", "B", "C", "D", "E"],
    "QTYPE_MCQ4_RTL":     ["D", "C", "B", "A"],
    "QTYPE_MCQ5_RTL":     ["E", "D", "C", "B", "A"],
    "QTYPE_TRUE_FALSE":   ["Đúng", "Sai"],
    "QTYPE_YES_NO":       ["Yes", "No"],
}

FIELD_TYPE_DIRECTIONS: dict[str, str] = {
    "QTYPE_INT":          "vertical",
    "QTYPE_INT_FROM_1":   "vertical",
    "QTYPE_MCQ4":         "horizontal",
    "QTYPE_MCQ5":         "horizontal",
    "QTYPE_MCQ4_RTL":     "horizontal",
    "QTYPE_MCQ5_RTL":     "horizontal",
    "QTYPE_TRUE_FALSE":   "horizontal",
    "QTYPE_YES_NO":       "horizontal",
}

# Semantic presets: define fieldType + default grid dimensions for well-known area types
SEMANTIC_PRESETS: dict[str, dict] = {
    "CCCD":        {"fieldType": "QTYPE_INT",        "labelPrefix": "cccd",  "physicalRows": 10, "physicalCols": 12},
    "SBD":         {"fieldType": "QTYPE_INT",        "labelPrefix": "sbd",   "physicalRows": 10, "physicalCols": 8},
    "MA_DE":       {"fieldType": "QTYPE_INT",        "labelPrefix": "made",  "physicalRows": 10, "physicalCols": 3},
    "CA_THI":      {"fieldType": "QTYPE_INT",        "labelPrefix": "cathi", "physicalRows": 10, "physicalCols": 2},
    "MCQ4":        {"fieldType": "QTYPE_MCQ4",       "labelPrefix": "q",     "physicalRows": 10, "physicalCols": 4},
    "TRUE_FALSE":  {"fieldType": "QTYPE_TRUE_FALSE", "labelPrefix": "ds",    "physicalRows": 10, "physicalCols": 2},
    "YES_NO":      {"fieldType": "QTYPE_YES_NO",     "labelPrefix": "yn",    "physicalRows": 10, "physicalCols": 2},
}

NON_ANSWER_SEMANTIC_TYPES: set[str] = {"SBD", "CCCD", "MA_DE", "CA_THI", "MADE", "SOBAODANH"}
ANSWER_FIELD_TYPES: set[str] = {
    "QTYPE_MCQ4", "QTYPE_MCQ5", "QTYPE_MCQ4_RTL", "QTYPE_MCQ5_RTL",
    "QTYPE_TRUE_FALSE", "QTYPE_YES_NO",
}
NON_ANSWER_FIELD_TYPES: set[str] = {"QTYPE_INT", "QTYPE_INT_FROM_1"}


# ── Exception ──────────────────────────────────────────────────────────────────

class CompileError(ValueError):
    """Raised when compile_template() detects one or more area errors."""

    def __init__(self, errors: list[str]) -> None:
        self.errors = errors
        super().__init__("\n".join(errors))


# ── Low-level helpers ──────────────────────────────────────────────────────────

def safe_form_id(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "_", value or "").strip("_")
    return cleaned or "default"


def is_int_field_type(field_type: str) -> bool:
    return str(field_type or "") in {"QTYPE_INT", "QTYPE_INT_FROM_1"}


def parse_positive_int(value: Any, default: int, *, minimum: int = 1) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = int(default)
    return max(minimum, parsed)


def parse_bubble_dimensions(value: Any, default: tuple | list = (19, 19)) -> list[int]:
    if not isinstance(value, (list, tuple)) or len(value) < 2:
        value = default
    return [
        parse_positive_int(value[0], default[0]),
        parse_positive_int(value[1], default[1]),
    ]


def parse_origin(area: dict, page_w: int, page_h: int) -> list[int] | None:
    raw_origin = area.get("origin")
    if isinstance(raw_origin, (list, tuple)) and len(raw_origin) >= 2:
        try:
            return [int(raw_origin[0]), int(raw_origin[1])]
        except (TypeError, ValueError):
            pass
    box = area.get("box", [])
    if isinstance(box, (list, tuple)) and len(box) == 4:
        try:
            return [int(box[0]), int(box[1])]
        except (TypeError, ValueError):
            pass
    return None


def parse_field_labels_raw(value: Any) -> list[str]:
    if isinstance(value, list):
        values = value
    else:
        values = re.split(r"[,;]", str(value or ""))
    return [str(item).strip() for item in values if str(item).strip()]


def expand_field_labels(raw_labels: list[str]) -> list[str]:
    """Expand range strings like 'q1..10' → ['q1', 'q2', ..., 'q10']."""
    result = []
    for raw in raw_labels:
        result.extend(expand_label_string(raw))
    return result


def make_field_labels_range(prefix: str, start: int, count: int) -> str:
    safe_prefix = str(prefix or "q").strip() or "q"
    safe_start = max(1, int(start or 1))
    safe_count = max(1, int(count or 1))
    return f"{safe_prefix}{safe_start}..{safe_start + safe_count - 1}"


def bool_from_payload(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, str):
        return value.strip().lower() not in {"", "0", "false", "no", "off"}
    return bool(value)


# ── Geometry ───────────────────────────────────────────────────────────────────

def cap_gap_to_axis(requested_gap: int, available: int, count: int, bubble_size: int) -> int:
    requested_gap = max(1, int(requested_gap or 1))
    available = max(1, int(available or 1))
    count = max(1, int(count or 1))
    bubble_size = max(1, int(bubble_size or 1))
    if count <= 1:
        return requested_gap
    max_gap = (available - bubble_size) // (count - 1)
    return max(1, min(requested_gap, max_gap))


def block_geometry_size(
    *,
    direction: str,
    bubble_dimensions: list[int],
    bubbles_gap: int,
    labels_gap: int,
    bubble_count: int,
    label_count: int,
) -> tuple[int, int]:
    bw, bh = bubble_dimensions
    if direction == "vertical":
        values_dim = bubbles_gap * (bubble_count - 1) + bh
        fields_dim = labels_gap * (label_count - 1) + bw
        return int(fields_dim), int(values_dim)
    values_dim = bubbles_gap * (bubble_count - 1) + bw
    fields_dim = labels_gap * (label_count - 1) + bh
    return int(values_dim), int(fields_dim)


def autofit_geometry_from_box(
    area: dict,
    *,
    direction: str,
    field_type: str,
    physical_rows: int,
    physical_cols: int,
) -> dict:
    """
    Calculate origin/bubbleDimensions/bubblesGap/labelsGap from bounding box.
    Used when autoFit=true and explicit geometry is not provided.
    """
    box = area.get("box") or []
    if not isinstance(box, (list, tuple)) or len(box) != 4:
        raise ValueError("autoFit=true cần box [x1,y1,x2,y2]")
    bx1, by1, bx2, by2 = [int(v) for v in box]
    box_w = max(1, bx2 - bx1)
    box_h = max(1, by2 - by1)
    rows = 10 if is_int_field_type(field_type) else max(1, int(physical_rows or 1))
    cols = max(1, int(physical_cols or 1))
    bubble_width = max(1, int(np.floor((box_w / cols) * 0.75)))
    bubble_height = max(1, int(np.floor((box_h / rows) * 0.75)))
    if direction == "vertical":
        bubbles_gap = (
            int(np.floor((box_h - bubble_height) / 9)) if is_int_field_type(field_type)
            else (int(np.floor((box_h - bubble_height) / (rows - 1))) if rows > 1 else 0)
        )
        labels_gap = int(np.floor((box_w - bubble_width) / (cols - 1))) if cols > 1 else 0
    else:
        bubbles_gap = int(np.floor((box_w - bubble_width) / (cols - 1))) if cols > 1 else 0
        labels_gap = int(np.floor((box_h - bubble_height) / (rows - 1))) if rows > 1 else 0
    return {
        "origin": [bx1, by1],
        "bubbleDimensions": [bubble_width, bubble_height],
        "bubblesGap": max(0, bubbles_gap),
        "labelsGap": max(0, labels_gap),
        "physicalRows": rows,
        "physicalCols": cols,
        "box": [bx1, by1, bx2, by2],
    }


# ── Core compile ───────────────────────────────────────────────────────────────

def compile_template(
    areas: list[dict],
    page_dimensions: tuple[int, int] | list[int] = DEFAULT_PAGE_SIZE,
    *,
    use_crop_on_markers: bool = False,
) -> dict:
    """
    Compile a list of area dicts into an OMR-compatible template dict.

    Raises CompileError (subclass of ValueError) with a list of error messages
    if any area is invalid.

    The returned dict matches the format expected by template_loader.load_template().
    """
    page_w, page_h = int(page_dimensions[0]), int(page_dimensions[1])
    if page_w <= 0 or page_h <= 0:
        raise CompileError([f"pageDimensions phải > 0, got [{page_w}, {page_h}]"])

    template: dict = {
        "pageDimensions": [page_w, page_h],
        "bubbleDimensions": [19, 19],
        "preProcessors": [],
        "use_markers": bool(use_crop_on_markers),
        "marker_type": "square" if use_crop_on_markers else "",
        "fieldBlocks": {},
    }
    if use_crop_on_markers:
        template["preProcessors"].append(MARKER_PREPROCESSOR)

    used_field_labels: set[str] = set()
    used_block_names: set[str] = set()
    errors: list[str] = []

    for area in areas:
        if area.get("type") != "omr":
            continue

        key = str(area.get("blockName") or area.get("key", "")).strip()
        if not key:
            errors.append("OMR block thiếu blockName/key")
            continue
        if key in used_block_names:
            errors.append(f"{key}: blockName bị trùng")
            continue
        used_block_names.add(key)

        origin = parse_origin(area, page_w, page_h)
        if origin is None:
            errors.append(f"{key}: thiếu origin hoặc box hợp lệ")
            continue
        x1, y1 = origin
        if x1 < 0 or y1 < 0 or x1 >= page_w or y1 >= page_h:
            errors.append(f"{key}: origin {origin} nằm ngoài pageDimensions [{page_w}, {page_h}]")
            continue

        # ── Resolve fieldType ────────────────────────────────────────────────
        semantic_type = str(area.get("semanticType") or "").strip().upper()
        semantic_enabled = bool(semantic_type)
        semantic_preset = SEMANTIC_PRESETS.get(semantic_type)
        field_type = str(area.get("fieldType") or "").strip()
        if semantic_preset:
            field_type = semantic_preset["fieldType"]
        if field_type.upper() in {"CUSTOM", "__CUSTOM__"}:
            field_type = ""
        if field_type and field_type not in FIELD_TYPE_VALUES:
            errors.append(f"{key}: fieldType không hợp lệ: {field_type!r}")
            continue

        bubble_values = [v.strip() for v in str(area.get("bubbleValues") or "").split(",") if v.strip()]
        if field_type:
            effective_bubble_values = FIELD_TYPE_VALUES[field_type]
            direction = FIELD_TYPE_DIRECTIONS[field_type]
        else:
            if not bubble_values:
                errors.append(f"{key}: custom fieldType cần bubbleValues")
                continue
            effective_bubble_values = bubble_values
            direction = str(area.get("direction") or "horizontal").strip()
            direction = "vertical" if direction == "vertical" else "horizontal"

        # ── Grid dimensions ──────────────────────────────────────────────────
        preset_rows = (semantic_preset or {}).get("physicalRows", len(effective_bubble_values))
        preset_cols = (semantic_preset or {}).get("physicalCols", len(effective_bubble_values))
        physical_rows = parse_positive_int(area.get("physicalRows"), preset_rows)
        if semantic_enabled and is_int_field_type(field_type):
            physical_rows = 10
        physical_cols = parse_positive_int(area.get("physicalCols"), preset_cols)
        expected_label_count = physical_cols if direction == "vertical" else physical_rows

        # ── fieldLabels ──────────────────────────────────────────────────────
        label_prefix = str(
            area.get("labelPrefix") or (semantic_preset or {}).get("labelPrefix") or "q"
        ).strip() or "q"
        label_start = parse_positive_int(area.get("labelStart"), 1)

        if semantic_enabled and bool_from_payload(area.get("autoFit"), False):
            raw_field_labels = [make_field_labels_range(label_prefix, label_start, expected_label_count)]
        else:
            raw_field_labels = parse_field_labels_raw(area.get("fieldLabels"))

        try:
            field_labels = expand_field_labels(raw_field_labels)
        except ValueError as exc:
            errors.append(f"{key}: {exc}")
            continue

        if not field_labels:
            errors.append(f"{key}: fieldLabels rỗng hoặc không expand được")
            continue
        if semantic_enabled and len(field_labels) != expected_label_count:
            errors.append(
                f"{key}: fieldLabels count={len(field_labels)} không khớp physical grid "
                f"(expected={expected_label_count}, direction={direction}, "
                f"rows={physical_rows}, cols={physical_cols})"
            )
            continue

        duplicates = sorted(lbl for lbl in field_labels if lbl in used_field_labels)
        if duplicates:
            errors.append(f"{key}: fieldLabels bị trùng với block khác: {', '.join(duplicates)}")
            continue
        for lbl in field_labels:
            used_field_labels.add(lbl)

        # ── Geometry (autoFit vs explicit) ───────────────────────────────────
        geometry_complete = (
            isinstance(area.get("origin"), (list, tuple))
            and len(area.get("origin") or []) >= 2
            and isinstance(area.get("bubbleDimensions"), (list, tuple))
            and len(area.get("bubbleDimensions") or []) >= 2
            and area.get("bubblesGap") is not None
            and area.get("labelsGap") is not None
        )
        use_autofit = semantic_enabled and bool_from_payload(area.get("autoFit"), False) and not geometry_complete

        if use_autofit:
            try:
                fitted = autofit_geometry_from_box(
                    area, direction=direction, field_type=field_type,
                    physical_rows=physical_rows, physical_cols=physical_cols,
                )
            except ValueError as exc:
                errors.append(f"{key}: {exc}")
                continue
            origin = fitted["origin"]
            x1, y1 = origin
            physical_rows = fitted["physicalRows"]
            physical_cols = fitted["physicalCols"]
            bubbles_gap = fitted["bubblesGap"]
            labels_gap = fitted["labelsGap"]
            bubble_dimensions = fitted["bubbleDimensions"]
        else:
            bubbles_gap = parse_positive_int(area.get("bubblesGap"), 18)
            labels_gap = parse_positive_int(area.get("labelsGap"), 21)
            bubble_dimensions = parse_bubble_dimensions(
                area.get("bubbleDimensions"), template["bubbleDimensions"]
            )

        # ── Page bounds check ────────────────────────────────────────────────
        block_w, block_h = block_geometry_size(
            direction=direction,
            bubble_dimensions=bubble_dimensions,
            bubbles_gap=bubbles_gap,
            labels_gap=labels_gap,
            bubble_count=len(effective_bubble_values),
            label_count=len(field_labels),
        )
        if x1 + block_w >= page_w or y1 + block_h >= page_h:
            errors.append(
                f"{key}: bubble grid overflow pageDimensions [{page_w}, {page_h}] "
                f"(origin={origin}, size=[{block_w}, {block_h}])"
            )
            continue

        # ── autoFit: individual bubble bounds check ──────────────────────────
        if use_autofit:
            box = area.get("box") or []
            bx1, by1, bx2, by2 = [int(v) for v in box]
            overflow = False
            for label_idx in range(len(field_labels)):
                for value_idx in range(len(effective_bubble_values)):
                    if direction == "vertical":
                        bub_x = x1 + label_idx * labels_gap
                        bub_y = y1 + value_idx * bubbles_gap
                    else:
                        bub_x = x1 + value_idx * bubbles_gap
                        bub_y = y1 + label_idx * labels_gap
                    if (
                        bub_x < bx1 or bub_y < by1
                        or bub_x + bubble_dimensions[0] > bx2
                        or bub_y + bubble_dimensions[1] > by2
                    ):
                        fl = field_labels[label_idx]
                        bv = effective_bubble_values[value_idx]
                        errors.append(
                            f"{key}: bubble {fl}:{bv} vượt box "
                            f"(bubble=[{bub_x}, {bub_y}, {bubble_dimensions[0]}, {bubble_dimensions[1]}], "
                            f"box=[{bx1}, {by1}, {bx2}, {by2}])"
                        )
                        overflow = True
                        break
                if overflow:
                    break
            if overflow:
                continue

        # ── Build fieldBlock ─────────────────────────────────────────────────
        block: dict = {
            "origin": [int(x1), int(y1)],
            "bubblesGap": int(bubbles_gap),
            "labelsGap": int(labels_gap),
            "fieldLabels": raw_field_labels,
            "bubbleDimensions": bubble_dimensions,
        }
        if field_type:
            block["fieldType"] = field_type
        else:
            block["bubbleValues"] = effective_bubble_values
            block["direction"] = direction
            block["emptyValue"] = str(area.get("emptyValue") or "")

        template["fieldBlocks"][key] = block

    if errors:
        raise CompileError(errors)

    return template


# ── Preview helpers ────────────────────────────────────────────────────────────

def build_preview_field_block(area: dict) -> tuple[str, dict, list[str]]:
    """
    Build a single fieldBlock from a preview area dict (used by preview-grid endpoint).
    Returns (block_name, field_block, warnings).
    Raises ValueError on invalid input.
    """
    warnings: list[str] = []
    block_name = str(area.get("blockName") or area.get("key") or "preview").strip()
    if not block_name:
        raise ValueError("blockName không được rỗng")

    raw_field_labels = parse_field_labels_raw(area.get("fieldLabels"))
    if not raw_field_labels:
        raise ValueError("fieldLabels không được rỗng")

    origin = area.get("origin")
    if not isinstance(origin, (list, tuple)) or len(origin) < 2:
        raise ValueError("origin phải là [x, y]")
    try:
        origin = [int(origin[0]), int(origin[1])]
    except (TypeError, ValueError):
        raise ValueError("origin phải là số nguyên")

    bubble_dimensions = parse_bubble_dimensions(area.get("bubbleDimensions"), [19, 19])
    bubbles_gap = parse_positive_int(area.get("bubblesGap"), 18)
    labels_gap = parse_positive_int(area.get("labelsGap"), 21)

    field_type = str(area.get("fieldType") or "").strip()
    if field_type.upper() in {"CUSTOM", "__CUSTOM__"}:
        field_type = ""

    block: dict = {
        "fieldLabels": raw_field_labels,
        "origin": origin,
        "bubbleDimensions": bubble_dimensions,
        "bubblesGap": bubbles_gap,
        "labelsGap": labels_gap,
    }

    if field_type:
        if field_type not in FIELD_TYPE_VALUES:
            raise ValueError(f"fieldType không hợp lệ: {field_type!r}")
        block["fieldType"] = field_type
    else:
        bubble_values = [v.strip() for v in str(area.get("bubbleValues") or "").split(",") if v.strip()]
        direction = str(area.get("direction") or "").strip()
        if direction not in {"horizontal", "vertical"}:
            raise ValueError("CUSTOM cần direction là horizontal hoặc vertical")
        if not bubble_values:
            raise ValueError("CUSTOM cần bubbleValues")
        block["bubbleValues"] = bubble_values
        block["direction"] = direction
        block["emptyValue"] = str(area.get("emptyValue") or "")

    return block_name, block, warnings


def build_preview_grid_fallback(
    block_name: str,
    field_block: dict,
    page_w: int,
    page_h: int,
    warnings: list[str],
) -> dict:
    """
    Compute bubble grid coordinates purely from field_block geometry (no OMRChecker core).
    Used as fallback when the OMR Template class is unavailable.
    """
    labels = expand_field_labels(field_block.get("fieldLabels") or [])
    field_type = str(field_block.get("fieldType") or "")
    if field_type:
        values = FIELD_TYPE_VALUES.get(field_type, [])
        direction = FIELD_TYPE_DIRECTIONS.get(field_type, "horizontal")
    else:
        values = list(field_block.get("bubbleValues") or [])
        direction = str(field_block.get("direction") or "horizontal")

    ox, oy = [int(v) for v in field_block["origin"]]
    bw, bh = [int(v) for v in field_block["bubbleDimensions"]]
    bubbles_gap = int(field_block["bubblesGap"])
    labels_gap = int(field_block["labelsGap"])
    block_w, block_h = block_geometry_size(
        direction=direction,
        bubble_dimensions=[bw, bh],
        bubbles_gap=bubbles_gap,
        labels_gap=labels_gap,
        bubble_count=len(values),
        label_count=len(labels),
    )
    bubbles = []
    out_of_bounds = False
    for label_idx, field_label in enumerate(labels):
        for value_idx, value in enumerate(values):
            if direction == "vertical":
                x = ox + label_idx * labels_gap
                y = oy + value_idx * bubbles_gap
            else:
                x = ox + value_idx * bubbles_gap
                y = oy + label_idx * labels_gap
            if x < 0 or y < 0 or x >= page_w or y >= page_h or x + bw > page_w or y + bh > page_h:
                out_of_bounds = True
            bubbles.append({
                "fieldLabel": field_label,
                "value": value,
                "x": int(x),
                "y": int(y),
                "w": int(bw),
                "h": int(bh),
                "centerX": float(x + bw / 2),
                "centerY": float(y + bh / 2),
            })
    if out_of_bounds and "Một phần preview grid nằm ngoài pageDimensions." not in warnings:
        warnings.append("Một phần preview grid nằm ngoài pageDimensions.")
    return {
        "blockName": block_name,
        "pageDimensions": [page_w, page_h],
        "block": {"x": ox, "y": oy, "w": int(block_w), "h": int(block_h)},
        "bubbles": bubbles,
        "warnings": warnings,
    }


# ── Answer field extraction ────────────────────────────────────────────────────

def _block_options(block: dict) -> list[str]:
    field_type = str(block.get("fieldType") or "").strip()
    if field_type in FIELD_TYPE_VALUES:
        return list(FIELD_TYPE_VALUES[field_type])
    bubble_values = block.get("bubbleValues") or []
    if isinstance(bubble_values, str):
        bubble_values = [v.strip() for v in re.split(r"[,;]", bubble_values) if v.strip()]
    return [str(v) for v in bubble_values if str(v)]


def _build_area_lookup(areas: list[dict] | None) -> dict[str, dict]:
    lookup: dict[str, dict] = {}
    if not isinstance(areas, list):
        return lookup
    for area in areas:
        if not isinstance(area, dict):
            continue
        for key in (area.get("blockName"), area.get("key"), area.get("label")):
            text = str(key or "").strip()
            if text:
                lookup[text] = area
                lookup[text.lower()] = area
    return lookup


def _should_include_answer_block(block_name: str, block: dict, area: dict | None) -> bool:
    semantic_type = str((area or {}).get("semanticType") or "").strip().upper()
    block_key = str(block_name or "").strip().upper()
    if semantic_type in NON_ANSWER_SEMANTIC_TYPES or block_key in NON_ANSWER_SEMANTIC_TYPES:
        return False
    if area:
        if "includeInAnswerKey" in area:
            return bool(area.get("includeInAnswerKey"))
        if "excludeFromAnswerKey" in area:
            return not bool(area.get("excludeFromAnswerKey"))
    field_type = str(block.get("fieldType") or "").strip()
    if field_type in NON_ANSWER_FIELD_TYPES:
        return False
    if field_type in ANSWER_FIELD_TYPES:
        return True
    return bool(_block_options(block))


def extract_answer_fields_from_template(
    template: dict,
    areas: list[dict] | None = None,
) -> list[dict]:
    """
    Return a list of answer field descriptors for building an answer key form.
    Non-answer blocks (SBD, CCCD, MA_DE…) are excluded.
    """
    if not isinstance(template, dict):
        return []
    field_blocks = template.get("fieldBlocks") or {}
    if not isinstance(field_blocks, dict):
        return []

    area_lookup = _build_area_lookup(areas)
    answer_fields: list[dict] = []

    for block_name, block in field_blocks.items():
        if not isinstance(block, dict):
            continue
        area = area_lookup.get(str(block_name)) or area_lookup.get(str(block_name).lower())
        if not _should_include_answer_block(block_name, block, area):
            continue
        labels = expand_field_labels(parse_field_labels_raw(block.get("fieldLabels")))
        options = _block_options(block)
        if not labels or not options:
            continue
        field_type = str(block.get("fieldType") or "").strip()
        if field_type in NON_ANSWER_FIELD_TYPES:
            # Composite INT answer block — returned as text input
            answer_fields.append({
                "key": str(block_name),
                "label": str((area or {}).get("label") or block_name),
                "blockName": str(block_name),
                "options": [],
                "inputType": "text",
                "sourceFields": labels,
                "composite": True,
            })
            continue
        for field_key in labels:
            m = re.search(r"(\d+)$", str(field_key))
            label_text = f"Câu {int(m.group(1))}" if m else str(field_key)
            answer_fields.append({
                "key": field_key,
                "label": label_text,
                "blockName": str(block_name),
                "options": options,
            })

    return answer_fields
