"""
template_geometry.py
====================
Utilities to inspect template geometry — query all bubbles for a given
field block or label.

The actual bubble generation lives in template_loader.py; this module
provides convenience accessors and summary helpers used by the engine
and debug overlay.
"""

from __future__ import annotations

from app.core.templates.template_loader import BubbleSpec, FieldBlockSpec, VJUTemplate


def get_bubbles_for_block(template: VJUTemplate, block_name: str) -> list[BubbleSpec]:
    """Return all BubbleSpec objects for a named block."""
    for block in template.field_blocks:
        if block.name == block_name:
            return block.bubbles
    raise KeyError(f"Block '{block_name}' not found in template")


def get_bubbles_for_label(template: VJUTemplate, field_label: str) -> list[BubbleSpec]:
    """Return bubbles for a single field_label (in bubble_value order)."""
    bubbles = template.bubbles_by_label.get(field_label)
    if bubbles is None:
        raise KeyError(f"Field label '{field_label}' not found in template")
    return bubbles


def iter_all_bubbles(template: VJUTemplate):
    """Yield every BubbleSpec across all blocks, in template order."""
    for block in template.field_blocks:
        yield from block.bubbles


def bounding_box(block: FieldBlockSpec) -> tuple[int, int, int, int]:
    """
    Return (x1, y1, x2, y2) bounding box for all bubbles in a block.
    Useful for drawing block outlines on debug overlays.
    """
    xs = [b.x for b in block.bubbles]
    ys = [b.y for b in block.bubbles]
    x2s = [b.x + b.w for b in block.bubbles]
    y2s = [b.y + b.h for b in block.bubbles]
    return min(xs), min(ys), max(x2s), max(y2s)


def summary(template: VJUTemplate) -> dict:
    """Return a human-readable summary dict — useful for logging / tests."""
    total_bubbles = sum(len(b.bubbles) for b in template.field_blocks)
    return {
        "template_path": str(template.path),
        "page_dimensions": template.page_dimensions,
        "default_bubble_dimensions": template.default_bubble_dimensions,
        "num_blocks": len(template.field_blocks),
        "num_labels": len(template.all_labels),
        "num_bubbles": total_bubbles,
        "blocks": [
            {
                "name": b.name,
                "field_type": b.field_type,
                "direction": b.direction,
                "num_labels": len(b.field_labels),
                "bubble_values": b.bubble_values,
                "bubble_dimensions": b.bubble_dimensions,
                "origin": b.origin,
                "bubblesGap": b.bubbles_gap,
                "labelsGap": b.labels_gap,
            }
            for b in template.field_blocks
        ],
    }
