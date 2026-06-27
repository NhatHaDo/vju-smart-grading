"""
batch_result_repository.py
===========================
Data-access layer for the batch_results table.

All methods operate on BatchResult only.  They never touch sheets, exams,
templates, or grading_results — deletions are local to this table.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.models.batch_result import BatchResult
from app.schemas.result_schema import ResultBatchSaveItem, ResultCorrectionRequest


@dataclass
class BatchResultFilters:
    """Optional filters for list_all()."""
    exam_id:          int | None  = None
    template_type:    str | None  = None
    template_variant: str | None  = None
    needs_review:     bool | None = None
    limit:            int         = 200
    offset:           int         = 0


class BatchResultRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    # ── Queries ───────────────────────────────────────────────────────────────

    def get_by_id(self, result_id: int) -> BatchResult | None:
        return self.db.query(BatchResult).filter(BatchResult.id == result_id).first()

    def list_all(self, filters: BatchResultFilters | None = None) -> tuple[list[BatchResult], int]:
        """
        Returns (items, total_count).
        Applies optional filters, then paginates with limit/offset.
        """
        f = filters or BatchResultFilters()
        q = self.db.query(BatchResult)

        if f.exam_id is not None:
            q = q.filter(BatchResult.exam_id == f.exam_id)
        if f.template_type is not None:
            q = q.filter(BatchResult.template_type == f.template_type)
        if f.template_variant is not None:
            q = q.filter(BatchResult.template_variant == f.template_variant)
        if f.needs_review is not None:
            q = q.filter(BatchResult.needs_review == f.needs_review)

        total = q.count()
        items = q.order_by(BatchResult.graded_at.desc()).offset(f.offset).limit(f.limit).all()
        return items, total

    # ── Create ────────────────────────────────────────────────────────────────

    def create_from_batch_item(
        self,
        item: ResultBatchSaveItem,
        *,
        batch_template_type:    str | None = None,
        batch_template_variant: str | None = None,
        batch_template_id:      int | None = None,
        batch_exam_id:          int | None = None,
    ) -> BatchResult:
        """
        Persist one ResultBatchSaveItem as a BatchResult row.
        Item-level fields take precedence over batch-level defaults.
        """
        def _j(v: Any) -> str:
            return json.dumps(v, ensure_ascii=False)

        severity = _compute_severity(
            needs_review=item.needs_review,
            empty_count=item.empty_count,
            multi_mark_count=item.multi_mark_count,
            explicit=item.severity,
        )

        row = BatchResult(
            exam_id           = item.exam_id          if item.exam_id          is not None else batch_exam_id,
            sheet_id          = item.sheet_id,
            template_type     = item.template_type    or batch_template_type,
            template_variant  = item.template_variant or batch_template_variant,
            template_id       = item.template_id      if item.template_id      is not None else batch_template_id,
            file_name         = item.file_name,
            cccd              = item.cccd,
            sbd               = item.sbd,
            ma_de             = item.ma_de,
            ca_thi            = item.ca_thi,
            ma_ctdt           = item.ma_ctdt,
            tu_chon           = item.tu_chon,
            answers_json      = _j(item.answers),
            scores_json       = _j(item.scores),
            section_json      = _j(item.sections),
            total_score       = item.total_score,
            severity          = severity,
            needs_review      = item.needs_review,
            empty_count       = item.empty_count,
            multi_mark_count  = item.multi_mark_count,
            warnings_json           = _j(item.warnings)           if item.warnings           is not None else None,
            info_field_columns_json = _j(item.info_field_columns) if item.info_field_columns is not None else None,
            debug_paths_json        = _j(item.debug_paths)        if item.debug_paths        is not None else None,
        )
        self.db.add(row)
        self.db.flush()   # get id without committing yet
        return row

    def create_batch(
        self,
        items: list[ResultBatchSaveItem],
        *,
        batch_template_type:    str | None = None,
        batch_template_variant: str | None = None,
        batch_template_id:      int | None = None,
        batch_exam_id:          int | None = None,
    ) -> list[BatchResult]:
        rows = [
            self.create_from_batch_item(
                item,
                batch_template_type=batch_template_type,
                batch_template_variant=batch_template_variant,
                batch_template_id=batch_template_id,
                batch_exam_id=batch_exam_id,
            )
            for item in items
        ]
        self.db.commit()
        for r in rows:
            self.db.refresh(r)
        return rows

    # ── Correction ────────────────────────────────────────────────────────────

    def save_correction(
        self,
        result_id: int,
        payload: ResultCorrectionRequest,
    ) -> BatchResult | None:
        """
        Apply manual corrections to an existing BatchResult row.
        - corrected_answers overrides answers_json (merged, not replaced wholesale)
        - corrected_student_info + notes stored in manual_corrections_json
        - mark_as_reviewed=True → sets needs_review=False, severity='corrected'
        Returns None if result_id not found.
        """
        row = self.get_by_id(result_id)
        if row is None:
            return None

        # Merge corrected answers into existing answers_json
        if payload.corrected_answers:
            existing = json.loads(row.answers_json or "{}")
            existing.update(payload.corrected_answers)
            row.answers_json = json.dumps(existing, ensure_ascii=False)

        # Build manual_corrections blob
        corrections: dict[str, Any] = {}
        try:
            corrections = json.loads(row.manual_corrections_json or "{}")
        except Exception:
            corrections = {}
        if payload.corrected_answers:
            corrections["corrected_answers"] = payload.corrected_answers
        if payload.corrected_student_info:
            corrections["corrected_student_info"] = payload.corrected_student_info
        if payload.notes:
            corrections["notes"] = payload.notes
        corrections["updated_at"] = datetime.now(timezone.utc).isoformat()
        row.manual_corrections_json = json.dumps(corrections, ensure_ascii=False)

        # Sync direct student-info columns from corrected_student_info if present
        if payload.corrected_student_info:
            csi = payload.corrected_student_info
            if 'ma_ctdt' in csi:
                row.ma_ctdt = csi['ma_ctdt'] or None
            if 'tu_chon' in csi:
                row.tu_chon = csi['tu_chon'] or None
            # Keep legacy VJU fields in sync too
            for col in ('cccd', 'sbd', 'ma_de', 'ca_thi'):
                if col in csi:
                    setattr(row, col, csi[col] or None)

        if payload.mark_as_reviewed:
            row.needs_review = False
            row.severity     = "corrected"
        row.corrected_at = datetime.now(timezone.utc)

        self.db.commit()
        self.db.refresh(row)
        return row

    # ── Delete ────────────────────────────────────────────────────────────────

    def delete(self, result_id: int) -> bool:
        """Delete one BatchResult. Returns True if found and deleted."""
        row = self.get_by_id(result_id)
        if row is None:
            return False
        self.db.delete(row)
        self.db.commit()
        return True

    def delete_all(self, filters: BatchResultFilters | None = None) -> int:
        """
        Delete all rows matching filters (or all rows if filters is None/empty).
        Returns number of deleted rows.
        Does NOT cascade to sheets/exams/templates.
        """
        f = filters or BatchResultFilters(limit=10_000)
        q = self.db.query(BatchResult)
        if f.exam_id is not None:
            q = q.filter(BatchResult.exam_id == f.exam_id)
        if f.template_type is not None:
            q = q.filter(BatchResult.template_type == f.template_type)
        count = q.delete(synchronize_session=False)
        self.db.commit()
        return count


# ── Helpers ───────────────────────────────────────────────────────────────────

def _compute_severity(
    *,
    needs_review: bool,
    empty_count: int,
    multi_mark_count: int,
    explicit: str,
) -> str:
    """
    If an explicit severity is supplied and is a known value, use it.
    Otherwise derive from counts (mirrors grading_service logic).
    """
    if explicit in ("ok", "low", "medium", "high", "corrected"):
        return explicit
    total_issues = empty_count + multi_mark_count
    if total_issues == 0 and not needs_review:
        return "ok"
    if total_issues <= 2:
        return "low"
    if total_issues <= 5:
        return "medium"
    return "high"
