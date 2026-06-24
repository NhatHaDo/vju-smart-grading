"""
results.py — Batch result persistence endpoints.

Routes
------
GET    /results              — list saved batch results (with filters)
GET    /results/{id}         — get one result
DELETE /results/{id}         — delete one result
DELETE /results              — delete all (optionally filtered)
POST   /results/batch        — save a frontend-submitted batch (B5)
PUT    /results/{id}/correction — apply manual correction (B6)

Design notes
------------
- These endpoints work against the `batch_results` table (BatchResult model).
- They do NOT touch GradingResult, sheets, exams, or the OMR engine.
- Auth: same require_roles("admin", "teacher") pattern as grading.py.
- POST /results/batch MUST be registered before GET /results/{id} so FastAPI
  does not try to match "batch" as an integer id.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.core.security.permissions import require_roles
from app.database import get_db
from app.models.user import User
from app.repositories.batch_result_repository import BatchResultFilters, BatchResultRepository
from app.schemas.result_schema import (
    BatchResultOut,
    ResultBatchSaveRequest,
    ResultBatchSaveResponse,
    ResultCorrectionRequest,
    ResultListOut,
)

router = APIRouter(prefix="/results", tags=["results"])


# ── GET /results ──────────────────────────────────────────────────────────────

@router.get(
    "",
    response_model=ResultListOut,
    summary="Danh sách kết quả chấm đã lưu",
)
def list_results(
    exam_id:          int  | None = Query(None, description="Lọc theo exam"),
    template_type:    str  | None = Query(None, description="sbd4 | sbd8 | custom"),
    template_variant: str  | None = Query(None),
    needs_review:     bool | None = Query(None, description="Lọc phiếu cần xem lại"),
    limit:            int         = Query(200,  ge=1, le=1000),
    offset:           int         = Query(0,    ge=0),
    db:               Session     = Depends(get_db),
    current_user:     User        = Depends(require_roles("admin", "teacher")),
) -> ResultListOut:
    repo = BatchResultRepository(db)
    filters = BatchResultFilters(
        exam_id=exam_id,
        template_type=template_type,
        template_variant=template_variant,
        needs_review=needs_review,
        limit=limit,
        offset=offset,
    )
    items, total = repo.list_all(filters)
    return ResultListOut(total=total, items=[BatchResultOut.model_validate(r) for r in items])


# ── POST /results/batch  (B5) — MUST come before /{id} ───────────────────────

@router.post(
    "/batch",
    response_model=ResultBatchSaveResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Lưu batch kết quả từ frontend (không chấm lại)",
)
def save_batch(
    payload:      ResultBatchSaveRequest,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(require_roles("admin", "teacher")),
) -> ResultBatchSaveResponse:
    """
    Receives a pre-graded batch (output of /omr/debug-grade) and persists
    each item to the batch_results table.

    - Does NOT re-run OMR or call the engine.
    - exam_id may be None → rows are saved with exam_id = NULL.
    - Idempotency: no deduplication — each call creates new rows.
      Frontend should call this once per grading session.
    """
    if not payload.items:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="items list is empty",
        )

    repo = BatchResultRepository(db)
    rows = repo.create_batch(
        payload.items,
        batch_template_type    = payload.template_type,
        batch_template_variant = payload.template_variant,
        batch_template_id      = payload.template_id,
        batch_exam_id          = payload.exam_id,
    )
    return ResultBatchSaveResponse(saved=len(rows), ids=[r.id for r in rows])


# ── GET /results/{id} ─────────────────────────────────────────────────────────

@router.get(
    "/{result_id}",
    response_model=BatchResultOut,
    summary="Lấy một kết quả",
)
def get_result(
    result_id:    int,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(require_roles("admin", "teacher")),
) -> BatchResultOut:
    repo = BatchResultRepository(db)
    row  = repo.get_by_id(result_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Result {result_id} not found")
    return BatchResultOut.model_validate(row)


# ── DELETE /results/{id} ──────────────────────────────────────────────────────

@router.delete(
    "/{result_id}",
    summary="Xoá một kết quả",
)
def delete_result(
    result_id:    int,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(require_roles("admin", "teacher")),
) -> dict:
    repo = BatchResultRepository(db)
    deleted = repo.delete(result_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Result {result_id} not found")
    return {"ok": True, "deleted_id": result_id}


# ── DELETE /results ────────────────────────────────────────────────────────────

@router.delete(
    "",
    summary="Xoá tất cả kết quả (có thể lọc theo exam_id / template_type)",
)
def delete_all_results(
    exam_id:       int | None = Query(None, description="Chỉ xoá theo exam"),
    template_type: str | None = Query(None),
    db:            Session    = Depends(get_db),
    current_user:  User       = Depends(require_roles("admin", "teacher")),
) -> dict:
    repo = BatchResultRepository(db)
    filters = BatchResultFilters(exam_id=exam_id, template_type=template_type)
    count = repo.delete_all(filters)
    return {"deleted": count}


# ── PUT /results/{id}/correction  (B6) ───────────────────────────────────────

@router.put(
    "/{result_id}/correction",
    response_model=BatchResultOut,
    summary="Lưu sửa thủ công từ ReviewErrorsPage",
)
def save_correction(
    result_id:    int,
    payload:      ResultCorrectionRequest,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(require_roles("admin", "teacher")),
) -> BatchResultOut:
    """
    Apply manual corrections to a saved result:
    - Merges corrected_answers into answers_json (does not overwrite other answers)
    - Stores full correction history in manual_corrections_json
    - If mark_as_reviewed=True: needs_review → False, severity → 'corrected'
    - Does NOT re-run OMR scoring
    """
    repo = BatchResultRepository(db)
    row  = repo.save_correction(result_id, payload)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Result {result_id} not found")
    return BatchResultOut.model_validate(row)
