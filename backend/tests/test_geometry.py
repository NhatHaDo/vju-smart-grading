"""
Unit tests for template_geometry.py helpers
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from app.core.templates.template_loader import load_template
from app.core.omr.template_geometry import (
    bounding_box,
    get_bubbles_for_block,
    get_bubbles_for_label,
    summary,
)

TEMPLATE_PATH = Path(__file__).parent.parent / "templates" / "vju_main_template.json"


@pytest.fixture(scope="module")
def template():
    if not TEMPLATE_PATH.exists():
        pytest.skip(f"Template not found: {TEMPLATE_PATH}")
    return load_template(TEMPLATE_PATH)


class TestGeometryHelpers:
    def test_get_bubbles_for_block(self, template):
        bubbles = get_bubbles_for_block(template, "Block_CCCD")
        # 12 labels × 10 digit values = 120 bubbles
        assert len(bubbles) == 120

    def test_get_bubbles_for_block_mcq(self, template):
        bubbles = get_bubbles_for_block(template, "Block_Toan")
        # 15 questions × 4 choices = 60 bubbles
        assert len(bubbles) == 60

    def test_get_bubbles_for_label(self, template):
        bubbles = get_bubbles_for_label(template, "cccd1")
        assert len(bubbles) == 10
        assert [b.bubble_value for b in bubbles] == ["1","2","3","4","5","6","7","8","9","0"]

    def test_get_bubbles_for_label_mcq(self, template):
        bubbles = get_bubbles_for_label(template, "toan5")
        assert len(bubbles) == 4
        assert [b.bubble_value for b in bubbles] == ["A", "B", "C", "D"]

    def test_missing_block_raises(self, template):
        with pytest.raises(KeyError):
            get_bubbles_for_block(template, "Block_DOESNOTEXIST")

    def test_missing_label_raises(self, template):
        with pytest.raises(KeyError):
            get_bubbles_for_label(template, "toan99")

    def test_bounding_box_cccd(self, template):
        """Bounding box computed from live block config — no hard-coded coords."""
        block = next(b for b in template.field_blocks if b.name == "Block_CCCD")
        x1, y1, x2, y2 = bounding_box(block)
        ox, oy = block.origin
        w,  h  = block.bubble_dimensions
        n_labels = len(block.field_labels)   # columns (fields)
        n_values = len(block.bubble_values)  # rows (digit values)
        # direction=vertical: labels go X (labelsGap), values go Y (bubblesGap)
        assert x1 == ox
        assert y1 == oy
        assert x2 == ox + (n_labels - 1) * block.labels_gap + w
        assert y2 == oy + (n_values - 1) * block.bubbles_gap + h

    def test_bounding_box_toan(self, template):
        """Bounding box for MCQ block derived from live config."""
        block = next(b for b in template.field_blocks if b.name == "Block_Toan")
        x1, y1, x2, y2 = bounding_box(block)
        ox, oy = block.origin
        w,  h  = block.bubble_dimensions
        n_labels = len(block.field_labels)   # rows (questions)
        n_values = len(block.bubble_values)  # cols (choices A-D)
        # direction=horizontal: values go X (bubblesGap), labels go Y (labelsGap)
        assert x1 == ox
        assert y1 == oy
        assert x2 == ox + (n_values - 1) * block.bubbles_gap + w
        # y2 may be clamped to page height if questions × labelsGap overflows
        expected_y2 = oy + (n_labels - 1) * block.labels_gap + h
        assert y2 == min(expected_y2, template.page_dimensions[1])

    def test_summary(self, template):
        s = summary(template)
        assert s["num_blocks"] == 13
        assert s["num_labels"] == 89
        assert s["page_dimensions"] == [2550, 3301]
        assert len(s["blocks"]) == 13


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
