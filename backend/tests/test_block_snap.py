"""block_snap: a block that sits off the printed bubbles after the warp is moved
back onto them; an aligned block is left alone; and it never slides a whole
row (the "half a pitch" case seen on the Bộ GD photos)."""
import cv2
import numpy as np

from app.core.omr.block_snap import block_offsets, shifted_template
from app.core.templates.template_loader import BubbleSpec, FieldBlockSpec, VJUTemplate

PITCH_X, PITCH_Y, D = 47, 24, 18


def _template(ox: int, oy: int) -> VJUTemplate:
    labels = [f"q{i}" for i in range(1, 11)]
    by_label, bubbles = {}, []
    for r, lbl in enumerate(labels):
        row = [BubbleSpec(lbl, v, ox + c * PITCH_X, oy + r * PITCH_Y, D, D, "QTYPE_MCQ4", "blk")
               for c, v in enumerate("ABCD")]
        by_label[lbl] = row
        bubbles += row
    blk = FieldBlockSpec("blk", "QTYPE_MCQ4", "horizontal", list("ABCD"), [ox, oy], PITCH_X, PITCH_Y,
                         labels, [D, D], bubbles=bubbles)
    return VJUTemplate(path=None, page_dimensions=[400, 400], default_bubble_dimensions=[D, D],
                       field_blocks=[blk], custom_labels={}, bubbles_by_label=by_label, all_labels=labels)


def _sheet(ox: int, oy: int) -> np.ndarray:
    img = np.full((400, 400), 255, np.uint8)
    for r in range(10):
        for c in range(4):
            cx, cy = ox + c * PITCH_X + D // 2, oy + r * PITCH_Y + D // 2
            cv2.circle(img, (cx, cy), 8, 0, 2, cv2.LINE_AA)
            if c == r % 4:
                cv2.circle(img, (cx, cy), 6, 0, -1)
    return img


def test_aligned_block_is_left_alone():
    assert block_offsets(_sheet(60, 60), _template(60, 60)) == {}


def test_offset_block_is_moved_back():
    off = block_offsets(_sheet(66, 70), _template(60, 60))
    assert off == {"blk": (6, 10)}
    moved = shifted_template(_template(60, 60), off)
    assert moved.bubbles_by_label["q1"][0].x == 66 and moved.field_blocks[0].bubbles[0].y == 70


def test_half_pitch_never_slides_a_row():
    # printed 13 px below the template (more than half the 24 px row pitch):
    # snapping one row up would also look close, but loses the last row
    dx, dy = block_offsets(_sheet(60, 73), _template(60, 60))["blk"]
    assert dx == 0 and 12 <= dy <= 14      # not -11 (one row up); ±1 px from circle detection


def test_blank_short_answer_column_reads_no_digit():
    """A blank digit column with one bubble a little darker than the rest
    (Phiếu Bộ GD photo, sheet 17, Câu 5) must not read a digit when the page's
    own marked/blank threshold is far below it; a real faint mark near the
    threshold still reads."""
    from app.core.omr.bubble_analyzer import BubbleStatus, classify_strip_int
    col = [BubbleSpec("tl5_d3", str(v), 0, v * 24, D, D, "QTYPE_INT", "tl5") for v in range(10)]
    blank = [224.3, 224.0, 224.0, 227.6, 224.4, 230.2, 225.5, 216.6, 223.9, 230.9]
    assert not [r for r in classify_strip_int(blank, col, 165.8) if r.status == BubbleStatus.MARKED]
    faint = [182.0, 191.5, 192.0, 190.0, 193.0, 191.0, 192.5, 190.5, 191.0, 192.0]
    marked = [r.bubble.bubble_value for r in classify_strip_int(faint, col, 165.8) if r.status == BubbleStatus.MARKED]
    assert marked == ["0"]


def test_bgd_template_offers_every_question_for_the_answer_key():
    """The shared Bộ GD template lists all 78 answers on Answer Key (40 ABCD,
    8 × 4 Đúng/Sai, 6 trả lời ngắn) — not only the 6 short ones."""
    import json
    from collections import Counter
    from app.core.templates.template_compiler import extract_answer_fields_from_template
    from app.services.shared_templates import BGD_SRC_AREAS, BGD_SRC_TPL
    fields = extract_answer_fields_from_template(json.loads(BGD_SRC_TPL.read_text(encoding="utf-8")),
                                                 json.loads(BGD_SRC_AREAS.read_text(encoding="utf-8")))
    kinds = Counter("short" if f.get("composite") else "".join(f["options"]) for f in fields)
    assert kinds == {"ABCD": 40, "ĐS": 32, "short": 6}


def test_bgd_template_crops_its_own_name_and_birthday_lines():
    """The Bộ GD info box sits elsewhere than Mẫu 40's: the template carries
    its own crop box for the handwritten Họ tên / Ngày sinh picture."""
    from app.core.omr.engine import OMREngine
    from app.core.templates.template_loader import load_template
    from app.services.shared_templates import BGD_SRC_TPL
    tpl = load_template(BGD_SRC_TPL)
    assert tpl.name_dob_crop_box == (240, 250, 725, 355)
    assert OMREngine(tpl)._get_name_dob_crop_box() == (240, 250, 725, 355)


def test_bgd_template_shows_sbd_and_ma_de_as_student_info():
    """Số báo danh and Mã đề are the sheet's info fields (result header, and
    the mã đề picks which đáp án grades the sheet)."""
    import json
    from app.api.v1.routes.custom_forms import _extract_info_fields
    from app.services.shared_templates import BGD_SRC_AREAS
    info = _extract_info_fields(json.loads(BGD_SRC_AREAS.read_text(encoding="utf-8")))
    assert [(f["key"], f["displayName"]) for f in info] == [("sbd", "Số Báo Danh"), ("made", "Mã Đề")]


def test_blank_abcd_row_is_not_flagged_when_far_lighter_than_the_page():
    """Phiếu Bộ GD sheet 8, câu 34: untouched, D only a little darker than
    A/B/C, page threshold 157.6 → blank (no "cần xem"); a real faint mark near
    the page threshold is still caught by the same rule."""
    from app.core.omr.bubble_analyzer import MCQ_OUTLIER_MIN_JUMP, get_local_threshold
    blank = [229.1, 226.1, 224.3, 216.9]
    thr = get_local_threshold(blank, 157.6, outlier_min_jump=MCQ_OUTLIER_MIN_JUMP)
    assert all(v > thr + 5 for v in blank)
    faint = [190.0, 199.0, 200.5, 201.0]
    thr = get_local_threshold(faint, 157.6, outlier_min_jump=MCQ_OUTLIER_MIN_JUMP)
    assert faint[0] < thr < faint[1]
