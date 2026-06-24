"""
result_schema.py
================
Pydantic schemas for grading results and batch persistence.

GradingResultOut  — existing single-sheet result (unchanged shape)
BatchResultOut    — new batch_results row; used by GET /results endpoints
ResultBatchSaveRequest / ResultBatchSaveItem — POST /results/batch payload
ResultCorrectionRequest  — PUT /results/{id}/correction payload
ResultListOut     — paginated list response
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


# ── Existing schema (kept backward-compatible) ────────────────────────────────

class GradingResultOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id:               int
    sheet_id:         int
    exam_id:          int
    student_id:       str | None
    answers_json:     str
    scores_json:      str
    section_json:     str
    total_score:      float
    severity:         str
    needs_review:     bool
    empty_count:      int
    multi_mark_count: int
    graded_at:        datetime


# ── New schemas for batch_results table ───────────────────────────────────────

class BatchResultOut(BaseModel):
    """Full row from batch_results — returned by GET /results and GET /results/{id}."""
    model_config = ConfigDict(from_attributes=True)

    id:                      int
    exam_id:                 int | None
    sheet_id:                int | None
    template_type:           str | None
    template_variant:        str | None
    template_id:             int | None
    file_name:               str | None
    cccd:                    str | None
    sbd:                     str | None
    ma_de:                   str | None
    ca_thi:                  str | None
    answers_json:            str
    scores_json:             str
    section_json:            str
    total_score:             float
    severity:                str
    needs_review:            bool
    empty_count:             int
    multi_mark_count:        int
    warnings_json:           str | None
    info_field_columns_json: str | None
    debug_paths_json:        str | None
    manual_corrections_json: str | None
    graded_at:               datetime
    corrected_at:            datetime | None


# ── Batch save payload ────────────────────────────────────────────────────────

class ResultBatchSaveItem(BaseModel):
    """
    One OMR result as returned by /omr/debug-grade.
    Frontend sends the raw OmrGradeResult shape; we map to DB columns.
    """
    file_name:        str
    template_type:    str | None               = None
    template_variant: str | None               = None
    template_id:      int | None               = None
    exam_id:          int | None               = None
    sheet_id:         int | None               = None

    # Student info (from OmrGradeResult.student_info)
    cccd:             str | None               = None
    sbd:              str | None               = None
    ma_de:            str | None               = None
    ca_thi:           str | None               = None

    # Answers + scoring
    answers:          dict[str, Any]           = {}
    scores:           dict[str, Any]           = {}
    sections:         dict[str, Any]           = {}
    total_score:      float                    = 0.0

    # Status
    severity:         str                      = "ok"
    needs_review:     bool                     = False
    empty_count:      int                      = 0
    multi_mark_count: int                      = 0

    # Extended blobs — accept any JSON-serialisable shape (list OR dict)
    # so the frontend can send InfoFieldColumns (object) without conversion.
    warnings:           Any | None             = None
    info_field_columns: Any | None             = None
    debug_paths:        Any | None             = None


class ResultBatchSaveRequest(BaseModel):
    """
    POST /api/v1/results/batch — full batch from one grading session.
    Top-level template_type/variant/id are batch-level defaults that each
    item can override.
    """
    template_type:    str | None               = None
    template_variant: str | None               = None
    template_id:      int | None               = None
    exam_id:          int | None               = None
    graded_at:        str | None               = None  # ISO string; if absent, uses DB now()
    items:            list[ResultBatchSaveItem]


class ResultBatchSaveResponse(BaseModel):
    """Response from POST /api/v1/results/batch."""
    saved:  int               # number of rows created
    ids:    list[int]         # created BatchResult.id list


# ── Correction payload ────────────────────────────────────────────────────────

class ResultCorrectionRequest(BaseModel):
    """
    PUT /api/v1/results/{id}/correction
    Frontend sends whatever ReviewErrorsPage has edited.
    """
    corrected_answers:      dict[str, Any] | None = None  # overrides answers_json
    corrected_student_info: dict[str, Any] | None = None  # metadata stored in manual_corrections_json
    notes:                  str | None            = None
    mark_as_reviewed:       bool                  = True   # sets needs_review = False


# ── List response ─────────────────────────────────────────────────────────────

class ResultListOut(BaseModel):
    total: int
    items: list[BatchResultOut]
