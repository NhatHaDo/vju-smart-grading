"""
2026-09-30, checked against a real "Mẫu 40" photo (Mã SV 25118109, mã đề
2601, 40 câu Phần I-II):
  - Chấm nhanh with a per-mã-đề key never found the mã đề on a custom
    template (its compiled JSON only has "custom_<id>" keys) → no score;
  - a 3-digit mã đề on the 4-column box reads "206_" / "0206";
  - Phần IV "75" in a 4-column box read "75__" → cần kiểm tra, never correct.
"""
import json

import pytest

from app.api.v1.routes.omr import ma_de_key_from_areas
from app.core.omr.engine import normalize_ma_de, pick_answer_set_for_ma_de
from app.core.omr.field_reader import FieldResult, FieldStatus, aggregate_signed_decimal
from app.core.omr.scorer import answers_match
from app.services.shared_templates import MAU40_SRC_AREAS


def _digit(label: str, value: str | None) -> FieldResult:
    return FieldResult(field_label=label, field_type="QTYPE_INT", selected_value=value,
                       selected_values=[value] if value else [],
                       status=FieldStatus.ANSWERED if value else FieldStatus.BLANK)


def _signed(digits: list[str | None], sign: bool = False, dec: str | None = None):
    return aggregate_signed_decimal(
        _digit("sign", "-" if sign else None),
        _digit("dec", dec),
        [_digit(f"d{i}", d) for i, d in enumerate(digits, 1)],
    )


@pytest.mark.parametrize("digits,sign,dec,expect", [
    (["7", "5", None, None], False, None, "75"),       # left-aligned, 2 unused columns
    ([None, None, "7", "5"], False, None, "75"),       # right-aligned, no comma
    (["2", "0", "2", "5"], False, None, "2025"),
    (["1", "5", None, None], True, "1", "-1.5"),       # -1,5
    (["0", "2", "5", None], False, "1", "0.25"),
])
def test_short_answer_ignores_unused_columns(digits, sign, dec, expect):
    value, status, _ = _signed(digits, sign, dec)
    assert (value, status) == (expect, FieldStatus.ANSWERED)


def test_short_answer_gap_inside_is_still_flagged():
    value, status, _ = _signed(["7", None, "5", None])
    assert status == FieldStatus.NEEDS_REVIEW and "_" in value


def test_short_answer_blank_stays_blank():
    assert _signed([None] * 4) == (None, FieldStatus.BLANK, [])


@pytest.mark.parametrize("student,key,ok", [
    ("75", "75", True), ("1.50", "1.5", True), ("1.5", "1,5", True), ("07", "7", True),
    ("-1.5", "1.5", False), ("A", "A", True), ("A", "B", False), (None, "A", False),
])
def test_answers_match(student, key, ok):
    assert answers_match(student, key) is ok


@pytest.mark.parametrize("raw,expect", [
    ("2601", "2601"), ("206_", "206"), ("_206", "206"), ("2_6_", None), ("2?01", None), ("____", None), (None, None),
])
def test_normalize_ma_de(raw, expect):
    assert normalize_ma_de(raw) == expect


def test_pick_answer_set_for_ma_de():
    sets = {"206": {"q": "A"}, "2601": {"q": "B"}}
    assert pick_answer_set_for_ma_de(sets, "2601") == {"q": "B"}
    assert pick_answer_set_for_ma_de(sets, "206_") == {"q": "A"}
    assert pick_answer_set_for_ma_de(sets, "0206") == {"q": "A"}   # leading zero bubbled
    assert pick_answer_set_for_ma_de(sets, "9999") is None
    assert pick_answer_set_for_ma_de(sets, "2_6_") is None


def test_ma_de_key_from_mau40_areas(tmp_path):
    key = ma_de_key_from_areas(str(MAU40_SRC_AREAS))
    compiled = json.loads(MAU40_SRC_AREAS.with_name("sheet_40tn_dungsai.template.json").read_text(encoding="utf-8"))
    assert key in compiled["customLabels"]
    assert compiled["customLabels"][key] == ["m1", "m2", "m3", "m4"]
    assert ma_de_key_from_areas(None) is None
    bad = tmp_path / "x.json"
    bad.write_text("not json")
    assert ma_de_key_from_areas(str(bad)) is None
