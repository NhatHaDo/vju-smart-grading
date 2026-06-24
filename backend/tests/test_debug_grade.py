"""
test_debug_grade.py
===================
Tests for POST /api/v1/omr/debug-grade (dev-only, no auth).

Test cases:
  1. Upload a valid image → 200 with correct JSON shape
  2. Upload a non-image file (PDF magic bytes / .txt) → 422
  3. OMR engine raises an exception → 500 with detail message
"""

import io
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app, raise_server_exceptions=False)

# ── helpers ──────────────────────────────────────────────────────────────────

def _minimal_jpeg() -> bytes:
    """4-byte JPEG SOI marker — enough for the suffix/MIME check to pass."""
    return b"\xff\xd8\xff\xe0" + b"\x00" * 16


def _mock_omr_result():
    """A minimal OMRResult-like MagicMock that satisfies all accessors."""
    from app.core.omr.field_reader import FieldStatus

    result = MagicMock()
    result.global_threshold = 142.5
    result.prep_method = "none"
    result.debug_overlay_path = "/tmp/overlay.jpg"
    result.warnings = []
    result.grading_report = None  # no answer_key → no score

    # Two MCQ fields + one digit field
    from app.core.omr.field_reader import FieldResult, FieldStatus
    result.field_results = {
        "toan1": FieldResult("toan1", "QTYPE_MCQ4", "A",
                              selected_values=["A"], status=FieldStatus.ANSWERED),
        "toan2": FieldResult("toan2", "QTYPE_MCQ4", None,
                              selected_values=[], status=FieldStatus.BLANK),
        "cccd1": FieldResult("cccd1", "QTYPE_INT_FROM_1", "3",
                              selected_values=["3"], status=FieldStatus.ANSWERED),
    }
    result.custom_values = {
        "CCCD":       ("012345678901", FieldStatus.ANSWERED),
        "SoBaoDanh":  ("00123456",     FieldStatus.ANSWERED),  # matches template key
        "MaDe":       ("301",          FieldStatus.ANSWERED),
        "CaThi":      ("1",            FieldStatus.ANSWERED),
        "MaCTDT":     ("15",           FieldStatus.ANSWERED),
        "TuChon":     ("1",            FieldStatus.ANSWERED),
    }
    return result


# ── 1. Valid image upload → 200 ───────────────────────────────────────────────

def test_debug_grade_valid_image(tmp_path):
    """Successful upload: mocked OMR engine returns a valid result."""
    template_path = (
        Path(__file__).parent.parent / "templates" / "vju_main_template.json"
    )
    if not template_path.exists():
        pytest.skip("vju_main_template.json not found")

    jpeg_bytes = _minimal_jpeg()
    omr_result = _mock_omr_result()

    from app.core.omr.engine import DebugVisualPaths
    vis = DebugVisualPaths(
        aligned_image_path="/tmp/aligned.jpg",
        overlay_all_path="/tmp/all.jpg",
        overlay_marked_only_path="/tmp/marked.jpg",
        overlay_warnings_path="/tmp/warn.jpg",
        means_json_path="/tmp/means.json",
    )

    with patch("app.api.v1.routes.omr.OMREngine") as MockEngine, \
         patch("app.api.v1.routes.omr.load_template") as mock_load_tpl, \
         patch("app.api.v1.routes.omr.DEFAULT_TEMPLATE", template_path):

        mock_load_tpl.return_value = MagicMock()
        MockEngine.return_value.run_full_debug.return_value = (omr_result, vis)

        response = client.post(
            "/api/v1/omr/debug-grade",
            files={"image": ("test_sheet.jpg", io.BytesIO(jpeg_bytes), "image/jpeg")},
        )

    assert response.status_code == 200, response.text
    data = response.json()

    # Top-level keys must all be present
    assert "input" in data
    assert "student_info" in data
    assert "answers" in data
    assert "warnings" in data
    assert "score" in data
    assert "debug" in data

    # MCQ answers extracted
    assert "toan1" in data["answers"]
    assert data["answers"]["toan1"] == "A"
    assert "toan2" in data["answers"]

    # Student info mapped
    assert data["student_info"]["sbd"] == "00123456"
    assert data["student_info"]["ma_de"] == "301"

    # Debug fields
    assert data["debug"]["threshold"] == 142.5
    assert data["debug"]["mean_mode"] == "circle_mask"
    assert data["debug"]["prep_method"] == "none"
    assert data["debug"]["aligned_image_path"] == "/tmp/aligned.jpg"
    assert data["debug"]["overlay_all_path"] == "/tmp/all.jpg"
    assert data["debug"]["overlay_marked_only_path"] == "/tmp/marked.jpg"
    assert data["debug"]["overlay_warnings_path"] == "/tmp/warn.jpg"
    assert data["debug"]["means_json_path"] == "/tmp/means.json"

    # Score is null (no answer_key)
    assert data["score"]["total"] is None

    # Input metadata
    assert data["input"]["filename"] == "test_sheet.jpg"


# ── 2. Non-image file → 422 ───────────────────────────────────────────────────

def test_debug_grade_invalid_file_type():
    """Uploading a .txt file must return 422."""
    text_content = b"This is not an image"

    response = client.post(
        "/api/v1/omr/debug-grade",
        files={"image": ("document.txt", io.BytesIO(text_content), "text/plain")},
    )

    assert response.status_code == 422, response.text
    detail = response.json().get("detail", "")
    # Must mention the issue
    assert "không hợp lệ" in detail.lower() or "jpeg" in detail.lower() or "png" in detail.lower()


def test_debug_grade_pdf_extension():
    """Uploading with a .pdf extension must also be rejected."""
    pdf_content = b"%PDF-1.4 fake pdf content"

    response = client.post(
        "/api/v1/omr/debug-grade",
        files={"image": ("sheet.pdf", io.BytesIO(pdf_content), "application/pdf")},
    )

    assert response.status_code == 422, response.text


# ── 3. OMR engine raises exception → 500 ─────────────────────────────────────

def test_debug_grade_omr_engine_failure():
    """If the OMR engine raises, the endpoint returns 500 with a clear detail."""
    template_path = (
        Path(__file__).parent.parent / "templates" / "vju_main_template.json"
    )
    if not template_path.exists():
        pytest.skip("vju_main_template.json not found")

    jpeg_bytes = _minimal_jpeg()

    with patch("app.api.v1.routes.omr.OMREngine") as MockEngine, \
         patch("app.api.v1.routes.omr.load_template") as mock_load_tpl, \
         patch("app.api.v1.routes.omr.DEFAULT_TEMPLATE", template_path):

        mock_load_tpl.return_value = MagicMock()
        MockEngine.return_value.run.side_effect = RuntimeError("Threshold computation failed")

        response = client.post(
            "/api/v1/omr/debug-grade",
            files={"image": ("test_sheet.jpg", io.BytesIO(jpeg_bytes), "image/jpeg")},
        )

    assert response.status_code == 500, response.text
    detail = response.json().get("detail", "")
    assert "OMR engine" in detail or "Threshold" in detail


# ── 4. answer_key_json parsed and forwarded ───────────────────────────────────

def test_debug_grade_with_answer_key():
    """answer_key_json query param is parsed and forwarded to engine.run()."""
    template_path = (
        Path(__file__).parent.parent / "templates" / "vju_main_template.json"
    )
    if not template_path.exists():
        pytest.skip("vju_main_template.json not found")

    jpeg_bytes = _minimal_jpeg()
    omr_result = _mock_omr_result()

    from app.core.omr.engine import DebugVisualPaths
    vis = DebugVisualPaths()

    with patch("app.api.v1.routes.omr.OMREngine") as MockEngine, \
         patch("app.api.v1.routes.omr.load_template") as mock_load_tpl, \
         patch("app.api.v1.routes.omr.DEFAULT_TEMPLATE", template_path):

        mock_load_tpl.return_value = MagicMock()
        mock_engine_instance = MockEngine.return_value
        mock_engine_instance.run_full_debug.return_value = (omr_result, vis)

        answer_key_str = '{"toan1":"A","toan2":"B"}'
        response = client.post(
            f"/api/v1/omr/debug-grade?answer_key_json={answer_key_str}",
            files={"image": ("test_sheet.jpg", io.BytesIO(jpeg_bytes), "image/jpeg")},
        )

    assert response.status_code == 200, response.text
    # Verify run_full_debug was called with the parsed answer key
    call_kwargs = mock_engine_instance.run_full_debug.call_args
    forwarded_key = call_kwargs.kwargs.get("answer_key")
    assert forwarded_key == {"toan1": "A", "toan2": "B"}


# ── 5. Invalid answer_key_json → 422 ─────────────────────────────────────────

def test_debug_grade_invalid_answer_key_json():
    """Malformed answer_key_json must return 422."""
    jpeg_bytes = _minimal_jpeg()

    template_path = (
        Path(__file__).parent.parent / "templates" / "vju_main_template.json"
    )
    if not template_path.exists():
        pytest.skip("vju_main_template.json not found")

    with patch("app.api.v1.routes.omr.load_template") as mock_load_tpl, \
         patch("app.api.v1.routes.omr.DEFAULT_TEMPLATE", template_path):
        mock_load_tpl.return_value = MagicMock()

        response = client.post(
            "/api/v1/omr/debug-grade?answer_key_json={bad json",
            files={"image": ("sheet.jpg", io.BytesIO(jpeg_bytes), "image/jpeg")},
        )

    assert response.status_code == 422, response.text
    assert "answer_key_json" in response.json().get("detail", "").lower() or \
           "json" in response.json().get("detail", "").lower()
