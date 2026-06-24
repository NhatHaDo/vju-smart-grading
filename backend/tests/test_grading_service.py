"""
test_grading_service.py
=======================
Unit tests for GradingService and grading routes.

Tests:
  1. grade_sheet — sheet not found → 404
  2. grade_sheet — image missing on disk → 422
  3. grade_sheet — template path missing → 422
  4. grade_sheet — success with real image (mock OMR engine)
  5. get_result   — sheet not graded yet → 404
  6. get_result   — returns stored result after grading
  7. _extract_student_info — custom label mapping
  8. _extract_warnings — multi_mark and too_light detected
"""

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi import HTTPException

from app.core.omr.field_reader import FieldResult, FieldStatus
from app.services.grading_service import GradingService


# ── Fixtures ──────────────────────────────────────────────────────────────

def _make_db():
    """Return a MagicMock that quacks like a SQLAlchemy Session."""
    db = MagicMock()
    # query(...).filter(...).first() default → None
    db.query.return_value.filter.return_value.first.return_value = None
    return db


def _make_sheet(id=1, file_path="/tmp/nonexistent.jpg", exam_id=1, status="pending"):
    sheet = MagicMock()
    sheet.id = id
    sheet.file_path = file_path
    sheet.exam_id = exam_id
    sheet.status = status
    return sheet


def _make_omr_result(needs_review=False, warnings=None):
    """Minimal OMRResult-like object."""
    from app.core.omr.engine import OMRResult
    result = OMRResult(
        field_results={
            "toan1": FieldResult("toan1", "QTYPE_MCQ4", "A",
                                  selected_values=["A"], status=FieldStatus.ANSWERED),
            "toan2": FieldResult("toan2", "QTYPE_MCQ4", None,
                                  selected_values=[], status=FieldStatus.BLANK),
            "cccd1": FieldResult("cccd1", "QTYPE_INT_FROM_1", "3",
                                  selected_values=["3"], status=FieldStatus.ANSWERED),
        },
        custom_values={
            "CCCD":       ("012345678901", FieldStatus.ANSWERED),
            "SoBaoDanh":  ("00123456",     FieldStatus.ANSWERED),  # matches template key
            "MaDe":       ("301",          FieldStatus.ANSWERED),
            "CaThi":      ("1",            FieldStatus.ANSWERED),
            "MaCTDT":     ("15",           FieldStatus.ANSWERED),
            "TuChon":     ("1",            FieldStatus.ANSWERED),
        },
        grading_report=None,
        prep_method="markers",
        global_threshold=150.0,
        warnings=warnings or [],
    )
    return result


# ── 1. Sheet not found → 404 ──────────────────────────────────────────────

def test_grade_sheet_not_found():
    db = _make_db()
    db.get.return_value = None  # SheetRepository.get_by_id uses db.get

    svc = GradingService(db)
    with pytest.raises(HTTPException) as exc_info:
        svc.grade_sheet(sheet_id=9999)
    assert exc_info.value.status_code == 404


# ── 2. Image missing on disk → 422 ───────────────────────────────────────

def test_grade_sheet_image_missing():
    db = _make_db()
    sheet = _make_sheet(file_path="/tmp/definitely_does_not_exist_xyz.jpg")
    db.get.return_value = sheet

    svc = GradingService(db)
    with pytest.raises(HTTPException) as exc_info:
        svc.grade_sheet(sheet_id=1)
    assert exc_info.value.status_code == 422
    assert "file ảnh" in exc_info.value.detail.lower() or "file" in exc_info.value.detail.lower()


# ── 3. Template missing → 422 ────────────────────────────────────────────

def test_grade_sheet_template_missing(tmp_path):
    # Create a real image file so the image check passes
    img_path = tmp_path / "sheet.jpg"
    img_path.write_bytes(b"\xff\xd8\xff")  # minimal JPEG magic bytes (enough for file.exists())

    db = _make_db()
    sheet = _make_sheet(file_path=str(img_path))
    db.get.return_value = sheet

    svc = GradingService(db)
    with pytest.raises(HTTPException) as exc_info:
        svc.grade_sheet(sheet_id=1, template_path="/nonexistent/template.json")
    assert exc_info.value.status_code == 422
    assert "template" in exc_info.value.detail.lower()


# ── 4. Success path (mock OMR engine) ────────────────────────────────────

def test_grade_sheet_success(tmp_path):
    """Full success path with a mocked OMREngine.run()."""
    # Create dummy image file
    img_path = tmp_path / "sheet.jpg"
    img_path.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 1000)

    # Use real template
    template_path = (
        Path(__file__).parent.parent / "templates" / "vju_main_template.json"
    )
    if not template_path.exists():
        pytest.skip("vju_main_template.json not found")

    db = _make_db()
    sheet = _make_sheet(file_path=str(img_path))
    db.get.return_value = sheet

    # Mock result repository
    mock_gr = MagicMock()
    mock_gr.id = 1
    db.query.return_value.filter.return_value.first.return_value = None  # no existing result

    omr_result = _make_omr_result()

    with patch("app.services.grading_service.OMREngine") as MockEngine:
        mock_instance = MockEngine.return_value
        mock_instance.run.return_value = omr_result

        with patch("app.services.grading_service.ResultRepository") as MockResultRepo:
            mock_result_repo = MockResultRepo.return_value
            mock_result_repo.upsert.return_value = mock_gr

            with patch("app.services.grading_service.SheetRepository") as MockSheetRepo:
                mock_sheet_repo = MockSheetRepo.return_value
                mock_sheet_repo.get_by_id.return_value = sheet
                mock_sheet_repo.update.return_value = sheet

                svc = GradingService(db)
                result = svc.grade_sheet(
                    sheet_id=1,
                    template_path=str(template_path),
                    save_debug_overlay=False,
                )

    assert result["sheet_id"] == 1
    assert result["status"] in ("graded", "needs_review")
    assert "student_info" in result
    assert "answers" in result
    assert "toan1" in result["answers"]
    assert result["student_info"]["sbd"] == "00123456"
    assert result["debug"]["prep_method"] == "markers"
    assert result["debug"]["global_threshold"] == 150.0


# ── 5. get_result — not graded → 404 ─────────────────────────────────────

def test_get_result_not_graded():
    db = _make_db()
    sheet = _make_sheet()
    db.get.return_value = sheet

    svc = GradingService(db)
    with pytest.raises(HTTPException) as exc_info:
        svc.get_result(sheet_id=1)
    assert exc_info.value.status_code == 404
    assert "chưa được chấm" in exc_info.value.detail.lower() or "grade" in exc_info.value.detail.lower()


# ── 6. get_result — returns stored result ────────────────────────────────

def test_get_result_returns_stored():
    db = _make_db()
    sheet = _make_sheet(status="graded")
    db.get.return_value = sheet

    mock_gr = MagicMock()
    mock_gr.student_id = "00123456"
    mock_gr.answers_json = json.dumps({"toan1": "A", "toan2": None})
    mock_gr.total_score = 1.0
    mock_gr.needs_review = False
    mock_gr.empty_count = 1
    mock_gr.multi_mark_count = 0
    mock_gr.graded_at = None

    with patch("app.services.grading_service.ResultRepository") as MockRepo:
        MockRepo.return_value.get_by_sheet.return_value = mock_gr
        with patch("app.services.grading_service.SheetRepository") as MockSheetRepo:
            MockSheetRepo.return_value.get_by_id.return_value = sheet
            svc = GradingService(db)
            result = svc.get_result(sheet_id=1)

    assert result["sheet_id"] == 1
    assert result["student_id"] == "00123456"
    assert result["answers"]["toan1"] == "A"
    assert result["total_score"] == 1.0


# ── 7. _extract_student_info mapping ─────────────────────────────────────

def test_extract_student_info():
    db = _make_db()
    svc = GradingService(db)
    omr = _make_omr_result()
    info = svc._extract_student_info(omr)
    assert info["sbd"] == "00123456"
    assert info["cccd"] == "012345678901"
    assert info["ma_de"] == "301"


# ── 8. _extract_warnings ─────────────────────────────────────────────────

def test_extract_warnings_multi_mark():
    db = _make_db()
    svc = GradingService(db)

    from app.core.omr.engine import OMRResult
    omr = OMRResult(
        field_results={
            "toan3": FieldResult(
                "toan3", "QTYPE_MCQ4", None,
                selected_values=["B", "C"],
                status=FieldStatus.MULTI_MARK,
            ),
            "toan4": FieldResult(
                "toan4", "QTYPE_MCQ4", "D",
                selected_values=["D"],
                status=FieldStatus.ANSWERED,
            ),
            "vl1": FieldResult(
                "vl1", "QTYPE_MCQ4", "A",
                selected_values=["A"],
                status=FieldStatus.TOO_LIGHT,
            ),
        },
        custom_values={},
        grading_report=None,
        prep_method="none",
        global_threshold=150.0,
        warnings=[],
    )
    warns = svc._extract_warnings(omr)
    types = {w["field"]: w["type"] for w in warns}
    assert types["toan3"] == "multi_mark"
    assert "B" in [w["candidates"] for w in warns if w["field"] == "toan3"][0]
    assert types["vl1"] == "too_light"
    assert "toan4" not in types
