"""
grading_service.py
==================
Orchestrates the full OMR grading pipeline for a single answer sheet.

Usage:
    from app.services.grading_service import GradingService
    result = GradingService(db).grade_sheet(sheet_id=1)
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.config import get_settings
from app.core.omr.engine import OMREngine, OMRResult
from app.core.omr.field_reader import FieldStatus
from app.core.templates.template_loader import load_template
from app.models.exam import AnswerKey
from app.models.result import GradingResult
from app.models.sheet import Sheet, SheetStatus
from app.repositories.exam_repository import ExamRepository
from app.repositories.result_repository import ResultRepository
from app.repositories.sheet_repository import SheetRepository

logger = logging.getLogger(__name__)
settings = get_settings()

# Default template shipped with the project
DEFAULT_TEMPLATE_PATH = Path(__file__).parent.parent.parent / "templates" / "vju_main_template.json"

# Custom-label → student-info key mapping
CUSTOM_LABEL_KEYS = {
    "CCCD":       "cccd",
    "SoBaoDanh":  "sbd",      # template customLabel key is "SoBaoDanh", not "SBD"
    "MaDe":       "ma_de",
    "CaThi":      "ca_thi",
    "MaCTDT":     "ma_ctdt",
    "TuChon":     "tu_chon",
}

# MCQ field labels (all are answer-column fields)
MCQ_PREFIXES = ("toan", "ptbv", "vl", "hh", "sh", "cnnn")


class GradingError(Exception):
    """Raised when grading cannot proceed (image missing, template broken, etc.)"""


class GradingService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.sheet_repo  = SheetRepository(db)
        self.exam_repo   = ExamRepository(db)
        self.result_repo = ResultRepository(db)

    # ── Public API ────────────────────────────────────────────────────────

    def grade_sheet(
        self,
        sheet_id: int,
        template_path: str | Path | None = None,
        mean_mode: str = "circle_mask",
        save_debug_overlay: bool = False,
    ) -> dict:
        """
        Run the full OMR pipeline for `sheet_id`.

        Steps:
          1. Load Sheet from DB (404 if missing)
          2. Validate image file exists on disk
          3. Load (or discover) VJU template
          4. Load answer key if exam has one
          5. Run OMREngine
          6. Parse student info + answers + warnings
          7. Upsert GradingResult in DB
          8. Update Sheet.status
          9. Return structured dict (response payload)

        Raises:
            HTTPException 404  — sheet not found
            HTTPException 422  — image file missing on disk
            HTTPException 500  — OMR engine crashed
        """
        # ── 1. Load sheet ────────────────────────────────────────────────
        sheet = self.sheet_repo.get_by_id(sheet_id)
        if not sheet:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Sheet {sheet_id} không tồn tại",
            )

        # ── 2. Validate image ────────────────────────────────────────────
        image_path = Path(sheet.file_path)
        if not image_path.exists():
            self._mark_error(sheet, f"Không tìm thấy file ảnh: {sheet.file_path}")
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"File ảnh không tồn tại trên disk: {sheet.file_path}",
            )

        # ── 3. Load template ─────────────────────────────────────────────
        tpl_path = Path(template_path) if template_path else DEFAULT_TEMPLATE_PATH
        if not tpl_path.exists():
            self._mark_error(sheet, f"Template không tồn tại: {tpl_path}")
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Template không tồn tại: {tpl_path}",
            )

        try:
            template = load_template(str(tpl_path))
        except Exception as exc:
            self._mark_error(sheet, f"Lỗi load template: {exc}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Không thể load template: {exc}",
            )

        # ── 4. Load answer key (optional) ────────────────────────────────
        answer_key: dict[str, str] | None = None
        answer_key_row: AnswerKey | None = (
            self.db.query(AnswerKey)
            .filter(AnswerKey.exam_id == sheet.exam_id)
            .first()
        )
        if answer_key_row and answer_key_row.answers_json:
            try:
                answer_key = json.loads(answer_key_row.answers_json) or None
            except json.JSONDecodeError:
                logger.warning(f"AnswerKey for exam {sheet.exam_id} has invalid JSON")

        # ── 5. Run OMR engine ────────────────────────────────────────────
        debug_dir = Path(settings.omr_output_dir) / "debug_overlays"
        debug_fname = f"sheet_{sheet_id}_overlay.jpg"

        self.sheet_repo.update(sheet, status=SheetStatus.PROCESSING)

        try:
            engine = OMREngine(
                template=template,
                enable_crop=True,
                debug_overlay_dir=debug_dir if save_debug_overlay else None,
                mean_mode=mean_mode,
            )
            omr_result: OMRResult = engine.run(
                str(image_path),
                answer_key=answer_key,
                debug_filename=debug_fname if save_debug_overlay else None,
            )
        except Exception as exc:
            logger.exception(f"OMR engine failed for sheet {sheet_id}")
            self._mark_error(sheet, f"OMR engine lỗi: {exc}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"OMR engine lỗi: {exc}",
            )

        # ── 6. Parse results ─────────────────────────────────────────────
        student_info = self._extract_student_info(omr_result)
        answers      = self._extract_answers(omr_result)
        warnings     = self._extract_warnings(omr_result)
        score_info   = self._extract_score(omr_result)
        needs_review = omr_result.needs_review or bool(warnings)

        # Determine final status
        final_status = (
            SheetStatus.NEEDS_REVIEW if needs_review else SheetStatus.GRADED
        )
        if omr_result.warnings:
            alignment_warning = "; ".join(omr_result.warnings)
        else:
            alignment_warning = None

        # Update sheet SBD
        sbd = student_info.get("sbd") or None

        # ── 7. Upsert GradingResult ──────────────────────────────────────
        empty_count      = sum(1 for r in omr_result.field_results.values()
                               if r.status == FieldStatus.BLANK)
        multi_mark_count = sum(1 for r in omr_result.field_results.values()
                               if r.status == FieldStatus.MULTI_MARK)

        db_result = self.result_repo.upsert(
            sheet_id=sheet_id,
            exam_id=sheet.exam_id,
            student_id=sbd,
            answers_json=json.dumps(answers, ensure_ascii=False),
            scores_json=json.dumps(score_info.get("per_field", {}), ensure_ascii=False),
            section_json=json.dumps(score_info.get("sections", {}), ensure_ascii=False),
            total_score=float(score_info.get("total", 0.0) or 0.0),
            needs_review=needs_review,
            empty_count=empty_count,
            multi_mark_count=multi_mark_count,
        )

        # ── 8. Update Sheet ──────────────────────────────────────────────
        self.sheet_repo.update(
            sheet,
            status=final_status,
            student_id=sbd,
            needs_review=needs_review,
            alignment_warning=alignment_warning,
            error_message=None,
        )

        # ── 9. Build response ────────────────────────────────────────────
        overlay_path = omr_result.debug_overlay_path
        response = {
            "sheet_id": sheet_id,
            "status": final_status,
            "student_info": student_info,
            "answers": answers,
            "warnings": warnings,
            "score": {
                "total":   score_info.get("total"),
                "max":     score_info.get("max"),
                "correct": score_info.get("correct"),
                "wrong":   score_info.get("wrong"),
                "blank":   score_info.get("blank"),
            },
            "debug": {
                "prep_method":         omr_result.prep_method,
                "global_threshold":    round(omr_result.global_threshold, 2),
                "mean_mode":           mean_mode,
                "alignment_warnings":  omr_result.warnings,
                "overlay_path":        overlay_path,
                "empty_count":         empty_count,
                "multi_mark_count":    multi_mark_count,
            },
        }

        logger.info(
            f"Graded sheet {sheet_id}: status={final_status} "
            f"sbd={sbd} score={score_info.get('total')} "
            f"warns={len(warnings)} empty={empty_count}"
        )
        return response

    def get_result(self, sheet_id: int) -> dict:
        """Return stored grading result for a sheet (404 if not yet graded)."""
        sheet = self.sheet_repo.get_by_id(sheet_id)
        if not sheet:
            raise HTTPException(status_code=404, detail="Sheet không tồn tại")

        db_result = self.result_repo.get_by_sheet(sheet_id)
        if not db_result:
            raise HTTPException(
                status_code=404,
                detail="Sheet chưa được chấm. Hãy gọi POST /grade trước",
            )

        answers = {}
        try:
            answers = json.loads(db_result.answers_json)
        except Exception:
            pass

        return {
            "sheet_id": sheet_id,
            "status": sheet.status,
            "student_id": db_result.student_id,
            "answers": answers,
            "total_score": db_result.total_score,
            "needs_review": db_result.needs_review,
            "empty_count": db_result.empty_count,
            "multi_mark_count": db_result.multi_mark_count,
            "graded_at": db_result.graded_at.isoformat() if db_result.graded_at else None,
        }

    # ── Private helpers ───────────────────────────────────────────────────

    def _mark_error(self, sheet: Sheet, msg: str) -> None:
        try:
            self.sheet_repo.update(sheet, status=SheetStatus.ERROR, error_message=msg)
        except Exception:
            pass

    def _extract_student_info(self, omr_result: OMRResult) -> dict:
        info: dict[str, str | None] = {}
        for custom_key, info_key in CUSTOM_LABEL_KEYS.items():
            val, st = omr_result.custom_values.get(custom_key, (None, None))
            info[info_key] = val if val and val.strip("?") else None
        return info

    def _extract_answers(self, omr_result: OMRResult) -> dict[str, str | None]:
        """Return {field_label: selected_value} for all MCQ/answer fields."""
        answers: dict[str, str | None] = {}
        for label, result in omr_result.field_results.items():
            # Include MCQ fields only (not CCCD/SBD digit columns)
            if any(label.startswith(pfx) for pfx in MCQ_PREFIXES):
                answers[label] = result.selected_value
        return answers

    def _extract_warnings(self, omr_result: OMRResult) -> list[dict]:
        """Collect per-field warnings (multi_mark, too_light, blank MCQ)."""
        warnings: list[dict] = []
        for label, result in omr_result.field_results.items():
            if not any(label.startswith(pfx) for pfx in MCQ_PREFIXES):
                continue
            if result.status == FieldStatus.MULTI_MARK:
                warnings.append({
                    "field": label,
                    "type": "multi_mark",
                    "candidates": result.selected_values,
                })
            elif result.status == FieldStatus.TOO_LIGHT:
                warnings.append({
                    "field": label,
                    "type": "too_light",
                    "candidates": result.selected_values,
                })
            elif result.status == FieldStatus.NEEDS_REVIEW:
                warnings.append({
                    "field": label,
                    "type": "needs_review",
                    "candidates": result.selected_values,
                })
        return warnings

    def _extract_score(self, omr_result: OMRResult) -> dict:
        """Extract score info from GradingReport (None if no answer key)."""
        rpt = omr_result.grading_report
        if rpt is None:
            return {"total": None, "max": None, "correct": None, "wrong": None, "blank": None,
                    "per_field": {}, "sections": {}}

        correct = sum(1 for q in rpt.questions if q.is_correct)
        wrong   = sum(1 for q in rpt.questions
                      if not q.is_correct and q.student_answer is not None)
        blank   = sum(1 for q in rpt.questions if q.student_answer is None)

        per_field = {
            q.field_label: {
                "correct_answer": q.correct_answer,
                "student_answer": q.student_answer,
                "is_correct": q.is_correct,
                "points": q.points_earned,
            }
            for q in rpt.questions
        }
        sections = {
            name: {
                "correct": sec.correct,
                "total": sec.total,
                "points_earned": round(sec.points_earned, 3),
                "points_possible": round(sec.points_possible, 3),
                "score_pct": round(sec.score_pct, 1),
            }
            for name, sec in rpt.sections.items()
        }

        return {
            "total":     round(rpt.total_score, 3),
            "max":       round(rpt.max_score, 3),
            "correct":   correct,
            "wrong":     wrong,
            "blank":     blank,
            "per_field": per_field,
            "sections":  sections,
        }
