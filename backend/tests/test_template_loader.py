"""
Unit tests for template_loader.py

Tests:
  1. Label range expansion (cccd1..12, toan1..15, sh6..10, single labels)
  2. Template JSON load + bubble count
  3. Origin / coordinate verification for first bubble of each block type
"""

import sys
from pathlib import Path

# Allow running from backend/ directory
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from app.core.templates.template_loader import (
    VJUTemplate,
    expand_label_string,
    load_template,
)

TEMPLATE_PATH = Path(__file__).parent.parent / "templates" / "vju_main_template.json"


# ── Label range expansion ─────────────────────────────────────────────────

class TestExpandLabelString:
    def test_range_basic(self):
        result = expand_label_string("cccd1..12")
        assert result == [f"cccd{i}" for i in range(1, 13)]
        assert len(result) == 12

    def test_range_single_digit_end(self):
        result = expand_label_string("sbd1..8")
        assert result == [f"sbd{i}" for i in range(1, 9)]
        assert len(result) == 8

    def test_range_toan(self):
        result = expand_label_string("toan1..15")
        assert len(result) == 15
        assert result[0] == "toan1"
        assert result[-1] == "toan15"

    def test_range_sh_starting_from_6(self):
        """sh6..10 should give sh6, sh7, sh8, sh9, sh10 (5 items)."""
        result = expand_label_string("sh6..10")
        assert result == ["sh6", "sh7", "sh8", "sh9", "sh10"]
        assert len(result) == 5

    def test_single_label(self):
        assert expand_label_string("toan1") == ["toan1"]

    def test_range_invalid_start_gte_end(self):
        with pytest.raises(ValueError, match="start"):
            expand_label_string("toan5..3")

    def test_range_start_equals_end(self):
        with pytest.raises(ValueError):
            expand_label_string("toan5..5")

    def test_triple_dot(self):
        """Three-dot range syntax should also work."""
        result = expand_label_string("cathi1...2")
        assert result == ["cathi1", "cathi2"]


# ── Template loading ──────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def template() -> VJUTemplate:
    if not TEMPLATE_PATH.exists():
        pytest.skip(f"Template not found: {TEMPLATE_PATH}")
    return load_template(TEMPLATE_PATH)


class TestTemplateLoad:
    def test_page_dimensions(self, template):
        assert template.page_dimensions == [2550, 3301]

    def test_default_bubble_dimensions(self, template):
        assert template.default_bubble_dimensions == [40, 40]

    def test_num_blocks(self, template):
        assert len(template.field_blocks) == 13

    def test_all_labels_count(self, template):
        # cccd(12)+sbd(8)+made(3)+cathi(2)+mactdt(2)+tuchon(2) = 29 INT labels
        # toan(15)+ptbv(5)+vl(10)+hh(10)+sh(5)+sh6(5)+cnnn(10) = 60 MCQ labels
        assert len(template.all_labels) == 89

    def test_custom_labels_expanded(self, template):
        assert len(template.custom_labels["CCCD"]) == 12
        assert template.custom_labels["CCCD"][0] == "cccd1"
        assert template.custom_labels["CCCD"][-1] == "cccd12"
        assert len(template.custom_labels["SoBaoDanh"]) == 8

    def test_bubbles_by_label_populated(self, template):
        # QTYPE_INT_FROM_1 → 10 bubble values per label
        assert len(template.bubbles_by_label["cccd1"]) == 10
        # QTYPE_MCQ4 → 4 bubble values per label
        assert len(template.bubbles_by_label["toan1"]) == 4


# ── Geometry: origin is top-left ──────────────────────────────────────────

class TestBubbleCoordinates:
    """
    Geometry tests derived from the live template config — no hard-coded coords.
    Safe to re-run after any template re-calibration.
    """

    def _block(self, template, name: str):
        return next(b for b in template.field_blocks if b.name == name)

    def test_cccd_first_bubble_origin(self, template):
        """First bubble of cccd1 must sit exactly at the block's current origin."""
        block = self._block(template, "Block_CCCD")
        first = template.bubbles_by_label["cccd1"][0]
        assert first.x == block.origin[0]
        assert first.y == block.origin[1]
        assert first.w == block.bubble_dimensions[0]
        assert first.h == block.bubble_dimensions[1]

    def test_cccd_column_shift(self, template):
        """cccd2 must be exactly labelsGap pixels to the right of cccd1."""
        block = self._block(template, "Block_CCCD")
        b1 = template.bubbles_by_label["cccd1"][0]
        b2 = template.bubbles_by_label["cccd2"][0]
        assert b2.x == b1.x + block.labels_gap
        assert b2.y == b1.y   # same row

    def test_cccd_vertical_bubbles_gap(self, template):
        """Within cccd1: value '2' must be bubblesGap below value '1'."""
        block   = self._block(template, "Block_CCCD")
        bubbles = template.bubbles_by_label["cccd1"]
        assert bubbles[0].bubble_value == "1"
        assert bubbles[1].bubble_value == "2"
        assert bubbles[1].y == bubbles[0].y + block.bubbles_gap

    def test_cccd_digit_0_is_last(self, template):
        """QTYPE_INT_FROM_1: '0' is last (index 9) at origin_y + 9*bubblesGap."""
        block   = self._block(template, "Block_CCCD")
        bubbles = template.bubbles_by_label["cccd1"]
        assert bubbles[9].bubble_value == "0"
        assert bubbles[9].y == block.origin[1] + 9 * block.bubbles_gap

    def test_toan_first_bubble_origin(self, template):
        """toan1 choice A must be at the Block_Toan origin."""
        block    = self._block(template, "Block_Toan")
        a_bubble = template.bubbles_by_label["toan1"][0]
        assert a_bubble.bubble_value == "A"
        assert a_bubble.x == block.origin[0]
        assert a_bubble.y == block.origin[1]
        assert a_bubble.w == block.bubble_dimensions[0]
        assert a_bubble.h == block.bubble_dimensions[1]

    def test_toan_horizontal_gap(self, template):
        """toan1: choice B must be bubblesGap to the right of A (MCQ4 horizontal)."""
        block   = self._block(template, "Block_Toan")
        bubbles = template.bubbles_by_label["toan1"]
        assert bubbles[0].bubble_value == "A"
        assert bubbles[1].bubble_value == "B"
        assert bubbles[1].x == bubbles[0].x + block.bubbles_gap
        assert bubbles[1].y == bubbles[0].y   # same row

    def test_toan_row_shift(self, template):
        """toan2 (question 2) must be labelsGap below toan1 (question 1)."""
        block = self._block(template, "Block_Toan")
        b1    = template.bubbles_by_label["toan1"][0]
        b2    = template.bubbles_by_label["toan2"][0]
        assert b2.y == b1.y + block.labels_gap
        assert b2.x == b1.x   # same column (choice A)

    def test_sh6_first_bubble(self, template):
        """sh6 first bubble must be at the Block_SinhHoc_6_10 origin."""
        block   = self._block(template, "Block_SinhHoc_6_10")
        bubbles = template.bubbles_by_label["sh6"]
        assert bubbles[0].x == block.origin[0]
        assert bubbles[0].y == block.origin[1]

    def test_all_bubbles_in_page_bounds(self, template):
        """Every generated bubble must lie within pageDimensions."""
        pw, ph = template.page_dimensions
        for block in template.field_blocks:
            for b in block.bubbles:
                assert b.x >= 0 and b.y >= 0, f"{b} has negative origin"
                assert b.x + b.w <= pw, f"{b} overflows page width"
                assert b.y + b.h <= ph, f"{b} overflows page height"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
