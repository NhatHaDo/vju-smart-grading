"""
omr.py — Dev-only OMR debug endpoint.

POST /omr/debug-grade
  • Accepts an uploaded image (multipart/form-data).
  • Saves it temporarily to uploads/debug/.
  • Runs the full OMR pipeline against vju_main_template.json.
  • Returns structured JSON without touching the database.
  • No authentication required (dev-only endpoint).

Query params:
  mean_mode   circle_mask (default) | rect
  answer_key  optional JSON string  e.g. '{"toan1":"A",...}'
"""

from __future__ import annotations

import json
import logging
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from sqlalchemy.orm import Session

from app.config import get_settings
from app.core.omr.engine import OMREngine, DebugVisualPaths
from app.core.omr.field_reader import FieldStatus
from app.core.templates.template_loader import load_template
from app.database import get_db
from app.repositories.template_repository import TemplateRepository
from app.core.omr.field_reader import FieldStatus as _FieldStatus
from app.services.grading_service import (
    CUSTOM_LABEL_KEYS,
    MCQ_PREFIXES,
)

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(prefix="/omr", tags=["omr-debug"])

# Allowed image MIME types / suffixes
_ALLOWED_MIME = {"image/jpeg", "image/png", "image/tiff", "image/webp", "image/bmp"}
_ALLOWED_SUFFIX = {".jpg", ".jpeg", ".png", ".tiff", ".tif", ".webp", ".bmp"}

# Template root
_TEMPLATE_DIR = Path(__file__).parent.parent.parent.parent.parent / "templates"

# Variant → calibrated template file
_VARIANT_MAP: dict[str, str] = {
    "sbd4": "vju_sbd4_template.calibrated.json",
    "sbd8": "vju_main_template.calibrated.json",
}

# Default template (fallback)
DEFAULT_TEMPLATE = _TEMPLATE_DIR / "vju_main_template.calibrated.json"


def _resolve_template(template_variant: str | None, template_path: str | None) -> Path:
    """Priority: template_variant > template_path > DEFAULT_TEMPLATE."""
    if template_variant:
        variant = template_variant.lower().strip()
        if variant not in _VARIANT_MAP:
            raise ValueError(
                f"template_variant không hợp lệ: '{template_variant}'. "
                f"Chỉ chấp nhận: {list(_VARIANT_MAP.keys())}"
            )
        return _TEMPLATE_DIR / _VARIANT_MAP[variant]
    if template_path:
        return Path(template_path)
    return DEFAULT_TEMPLATE


def _extract_student_info(omr_result) -> dict:
    info: dict = {}
    for custom_key, info_key in CUSTOM_LABEL_KEYS.items():
        val, _st = omr_result.custom_values.get(custom_key, (None, None))
        info[info_key] = val if val and val.strip("?") else None
    return info


def _extract_answers(omr_result) -> dict:
    return {
        label: result.selected_value
        for label, result in omr_result.field_results.items()
        if any(label.startswith(pfx) for pfx in MCQ_PREFIXES)
    }


_INT_FIELD_TYPES = {"QTYPE_INT_FROM_1", "QTYPE_INT"}


# ── Custom-template extraction helpers ────────────────────────────────────────

def _extract_student_info_custom(omr_result, template) -> dict:
    """For custom templates: assemble INT block values as composite strings.
    Key = block.name (e.g. "custom_1782375370047")."""
    info: dict[str, str | None] = {}
    for block in template.field_blocks:
        if block.field_type not in _INT_FIELD_TYPES:
            continue
        parts = []
        for lbl in block.field_labels:
            fr = omr_result.field_results.get(lbl)
            if fr and fr.selected_value and fr.status != _FieldStatus.BLANK:
                parts.append(fr.selected_value)
            else:
                parts.append("_")
        composite = "".join(parts)
        # Return None if entirely blank
        info[block.name] = None if all(c == "_" for c in composite) else composite
    return info


def _extract_answers_custom(omr_result, template) -> dict:
    """For custom templates: extract all MCQ block label values."""
    answers: dict[str, str | None] = {}
    for block in template.field_blocks:
        if block.field_type in _INT_FIELD_TYPES:
            continue
        for lbl in block.field_labels:
            fr = omr_result.field_results.get(lbl)
            answers[lbl] = fr.selected_value if fr else None
    return answers


def _extract_warnings_custom(omr_result, template) -> list[dict]:
    """MCQ-field warnings for custom templates (not filtered by MCQ_PREFIXES)."""
    warnings = []
    for block in template.field_blocks:
        if block.field_type in _INT_FIELD_TYPES:
            continue
        for lbl in block.field_labels:
            result = omr_result.field_results.get(lbl)
            if result is None:
                continue
            if result.status == _FieldStatus.MULTI_MARK:
                warnings.append({"field": lbl, "type": "multi_mark", "candidates": result.selected_values})
            elif result.status == _FieldStatus.TOO_LIGHT:
                warnings.append({"field": lbl, "type": "too_light", "candidates": result.selected_values})
            elif result.status == _FieldStatus.NEEDS_REVIEW:
                warnings.append({"field": lbl, "type": "needs_review", "candidates": result.selected_values})
    return warnings


def _extract_info_warnings_custom(omr_result, template) -> list[dict]:
    """INT-field warnings for custom templates, keyed by blockName."""
    warnings = []
    # Build label → blockName mapping
    lbl_to_block: dict[str, str] = {}
    for block in template.field_blocks:
        if block.field_type not in _INT_FIELD_TYPES:
            continue
        for lbl in block.field_labels:
            lbl_to_block[lbl] = block.name
    for lbl, fr in omr_result.field_results.items():
        block_name = lbl_to_block.get(lbl)
        if block_name is None:
            continue
        if fr.status == _FieldStatus.MULTI_MARK:
            warnings.append({"field": block_name, "column": lbl, "type": "multi_mark_info_field", "candidates": fr.selected_values})
        elif fr.status == _FieldStatus.TOO_LIGHT:
            warnings.append({"field": block_name, "column": lbl, "type": "too_light_info_field", "candidates": fr.selected_values})
    return warnings


def _build_info_field_columns_custom(omr_result, template) -> dict:
    """Per-column breakdown of INT blocks for custom templates, keyed by blockName."""
    result: dict[str, list[dict]] = {}
    for block in template.field_blocks:
        if block.field_type not in _INT_FIELD_TYPES:
            continue
        columns: list[dict] = []
        for idx, lbl in enumerate(block.field_labels):
            fr = omr_result.field_results.get(lbl)
            if fr is None or fr.status == _FieldStatus.BLANK:
                columns.append({"columnIndex": idx, "value": "_", "digits": [], "status": "blank"})
            elif fr.status == _FieldStatus.MULTI_MARK:
                digits = fr.selected_values or []
                columns.append({"columnIndex": idx, "value": "".join(digits), "digits": digits, "status": "multi_mark"})
            elif fr.status == _FieldStatus.TOO_LIGHT:
                digits = fr.selected_values or []
                columns.append({"columnIndex": idx, "value": "".join(digits) if digits else "_", "digits": digits, "status": "too_light"})
            else:
                digits = fr.selected_values or []
                columns.append({"columnIndex": idx, "value": fr.selected_value or "_", "digits": digits, "status": "single"})
        result[block.name] = columns
    return result


def _build_info_field_columns(omr_result, template) -> dict:
    """
    Build structured per-column representation of all INT custom labels.

    Returns a dict keyed by student-info field name (e.g. "ma_de"), each value
    being a list of column specs in template order:
      { columnIndex, value, digits, status }
    where status is one of: "single" | "multi_mark" | "too_light" | "blank"

    This lets the frontend highlight individual multi-marked columns without
    trying to parse a raw concatenated string.
    """
    # label → field_type lookup
    label_field_type: dict[str, str] = {}
    for block in template.field_blocks:
        for lbl in block.field_labels:
            label_field_type[lbl] = block.field_type

    result: dict[str, list[dict]] = {}

    for custom_key, component_labels in template.custom_labels.items():
        if not component_labels:
            continue
        # Only process INT-type custom labels
        if label_field_type.get(component_labels[0], "") not in _INT_FIELD_TYPES:
            continue

        info_key = CUSTOM_LABEL_KEYS.get(custom_key, custom_key.lower())
        columns: list[dict] = []

        for idx, lbl in enumerate(component_labels):
            fr = omr_result.field_results.get(lbl)
            if fr is None or fr.status == _FieldStatus.BLANK:
                columns.append({
                    "columnIndex": idx,
                    "value":       "_",
                    "digits":      [],
                    "status":      "blank",
                })
            elif fr.status == _FieldStatus.MULTI_MARK:
                digits = fr.selected_values or []
                columns.append({
                    "columnIndex": idx,
                    "value":       "".join(digits),
                    "digits":      digits,
                    "status":      "multi_mark",
                })
            elif fr.status == _FieldStatus.TOO_LIGHT:
                digits = fr.selected_values or []
                columns.append({
                    "columnIndex": idx,
                    "value":       "".join(digits) if digits else "_",
                    "digits":      digits,
                    "status":      "too_light",
                })
            else:  # ANSWERED (or anything else)
                digits = fr.selected_values or []
                columns.append({
                    "columnIndex": idx,
                    "value":       fr.selected_value or "_",
                    "digits":      digits,
                    "status":      "single",
                })

        result[info_key] = columns

    return result


def _extract_info_warnings(omr_result, template) -> list[dict]:
    """
    Return warnings for INT fields that have multi-marked or ambiguous columns.
    Separate from MCQ warnings so the frontend can style them differently.
    """
    label_field_type: dict[str, str] = {}
    for block in template.field_blocks:
        for lbl in block.field_labels:
            label_field_type[lbl] = block.field_type

    # Build reverse: component label → custom label name
    label_to_custom: dict[str, str] = {}
    for custom_key, component_labels in template.custom_labels.items():
        info_key = CUSTOM_LABEL_KEYS.get(custom_key, custom_key.lower())
        for lbl in component_labels:
            label_to_custom[lbl] = info_key

    warnings: list[dict] = []
    for lbl, fr in omr_result.field_results.items():
        if label_field_type.get(lbl, "") not in _INT_FIELD_TYPES:
            continue
        if fr.status == _FieldStatus.MULTI_MARK:
            warnings.append({
                "field":      label_to_custom.get(lbl, lbl),
                "column":     lbl,
                "type":       "multi_mark_info_field",
                "candidates": fr.selected_values,
            })
        elif fr.status == _FieldStatus.TOO_LIGHT:
            warnings.append({
                "field":      label_to_custom.get(lbl, lbl),
                "column":     lbl,
                "type":       "too_light_info_field",
                "candidates": fr.selected_values,
            })

    return warnings


def _extract_warnings(omr_result) -> list[dict]:
    warnings = []
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


def _extract_score(omr_result) -> dict:
    rpt = omr_result.grading_report
    if rpt is None:
        return {"total": None, "max": None, "correct": None, "wrong": None, "blank": None}
    correct = sum(1 for q in rpt.questions if q.is_correct)
    wrong   = sum(1 for q in rpt.questions if not q.is_correct and q.student_answer is not None)
    blank   = sum(1 for q in rpt.questions if q.student_answer is None)
    return {
        "total":   round(rpt.total_score, 3),
        "max":     round(rpt.max_score, 3),
        "correct": correct,
        "wrong":   wrong,
        "blank":   blank,
    }


# ── Route ─────────────────────────────────────────────────────────────────────

@router.post(
    "/debug-grade",
    summary="[DEV] Chấm OMR trực tiếp từ ảnh upload — không cần database",
    status_code=200,
)
async def debug_grade(
    image: UploadFile = File(..., description="Ảnh phiếu trả lời (JPEG/PNG/TIFF)"),
    mean_mode: str = Query(
        default="circle_mask",
        description="Phương pháp đo bubble: 'circle_mask' (default) hoặc 'rect'",
    ),
    answer_key_json: str | None = Query(
        default=None,
        description='JSON string answer key, ví dụ: \'{"toan1":"A","toan2":"B"}\'',
    ),
    template_variant: str | None = Query(
        default=None,
        description="Variant template: 'sbd4' (SBD 4 số) hoặc 'sbd8' (SBD 8 số). "
                    "Nếu không truyền, dùng template_path hoặc mặc định sbd8.",
    ),
    template_path: str | None = Query(
        default=None,
        description="Đường dẫn template JSON tuỳ chỉnh (bị ghi đè bởi template_variant nếu có).",
    ),
    template_id: int | None = Query(
        default=None,
        description="ID custom template đã tạo qua Define Areas. "
                    "Ưu tiên cao nhất — backend tự resolve file_path từ DB.",
    ),
    block_filter: str | None = Query(
        default=None,
        description="Chỉ vẽ block này trong marked_only/warnings overlay (ví dụ: Block_CCCD)",
    ),
    full_debug: bool = Query(
        default=True,
        description="Xuất tất cả 4 ảnh debug + means.json (mặc định: true)",
    ),
    image_source: str = Query(
        default="auto",
        description="Nguồn ảnh: 'auto' | 'flatbed' | 'scan_app' | 'camera'. "
                    "Ảnh hưởng đến chiến lược tiền xử lý (warp threshold, denoise, v.v.).",
    ),
    db: Session = Depends(get_db),
) -> dict:
    """
    Dev-only endpoint — chấm OMR không qua database.

    Upload ảnh phiếu trả lời → pipeline OMR → trả JSON kết quả.

    **Không cần authentication.** Chỉ dùng trong môi trường dev/test.

    **Response fields:**
    - `student_info`     — CCCD, SBD, MaDe, CaThi, MaCTDT, TuChon
    - `answers`          — {field_label: selected_value}
    - `warnings`         — [{field, type, candidates}]
    - `score`            — {total, max, correct, wrong, blank} (null nếu không có answer_key)
    - `debug.threshold`         — global threshold value
    - `debug.mean_mode`         — mean_mode dùng trong run này
    - `debug.prep_method`       — markers | croppage | none
    - `debug.overlay_path`      — đường dẫn overlay image đã lưu
    - `debug.aligned_image_path`— (reserved, hiện null)
    - `debug.alignment_warnings`— cảnh báo từ preprocessor
    - `input.filename`          — tên file gốc
    - `input.saved_as`          — đường dẫn tạm trên server
    """
    # ── 1. Validate file type ─────────────────────────────────────────────
    suffix = Path(image.filename or "").suffix.lower()
    content_type = (image.content_type or "").split(";")[0].strip().lower()

    if suffix not in _ALLOWED_SUFFIX and content_type not in _ALLOWED_MIME:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"File không hợp lệ. Chỉ chấp nhận: JPEG, PNG, TIFF, BMP, WebP. "
                f"Nhận được: content_type='{content_type}', suffix='{suffix}'"
            ),
        )

    # ── 2. Save uploaded file to uploads/debug/ ───────────────────────────
    debug_upload_dir = Path(settings.omr_upload_dir) / "debug"
    debug_upload_dir.mkdir(parents=True, exist_ok=True)

    unique_name = f"{uuid.uuid4().hex}{suffix or '.jpg'}"
    save_path = debug_upload_dir / unique_name

    try:
        with save_path.open("wb") as f:
            shutil.copyfileobj(image.file, f)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Lỗi lưu file: {exc}",
        )

    # ── 3. Load template ──────────────────────────────────────────────────
    # Priority: template_id (DB lookup) > template_variant > template_path > default
    _tpl_meta: dict | None = None  # extra metadata added to response when using custom template

    if template_id is not None:
        repo = TemplateRepository(db)
        tpl_record = repo.get_by_id(template_id)
        if tpl_record is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Template ID {template_id} không tồn tại",
            )
        if not tpl_record.file_path:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Template ID {template_id} chưa có file compiled — hãy Save Template trước",
            )
        tpl_path = Path(tpl_record.file_path)
        _tpl_meta = {
            "template_id":   tpl_record.id,
            "template_name": tpl_record.name,
            "template_type": tpl_record.type,
        }
        logger.info("Using custom template id=%d name=%r path=%s", tpl_record.id, tpl_record.name, tpl_path)
    else:
        try:
            tpl_path = _resolve_template(template_variant, template_path)
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
        logger.info("Using template: %s (variant=%s)", tpl_path.name, template_variant)

    if not tpl_path.exists():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Template không tồn tại: {tpl_path}",
        )

    try:
        template = load_template(str(tpl_path))
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Không thể load template: {exc}",
        )

    # ── 4. Parse optional answer_key ──────────────────────────────────────
    answer_key: dict | None = None
    if answer_key_json:
        try:
            answer_key = json.loads(answer_key_json)
        except json.JSONDecodeError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"answer_key_json không phải JSON hợp lệ: {exc}",
            )

    # ── 5. Run OMR engine ─────────────────────────────────────────────────
    debug_overlay_dir = Path(settings.omr_output_dir) / "debug_overlays"
    debug_overlay_dir.mkdir(parents=True, exist_ok=True)
    stem = unique_name.rsplit(".", 1)[0]

    try:
        engine = OMREngine(
            template=template,
            enable_crop=True,
            debug_overlay_dir=debug_overlay_dir,
            mean_mode=mean_mode,
        )

        vis = DebugVisualPaths()

        if full_debug:
            omr_result, vis = engine.run_full_debug(
                str(save_path),
                output_dir=debug_overlay_dir,
                prefix=stem,
                answer_key=answer_key,
                block_filter=block_filter,
                image_source=image_source,
            )
        else:
            omr_result = engine.run(
                str(save_path),
                answer_key=answer_key,
                debug_filename=f"{stem}_overlay_all.jpg",
                image_source=image_source,
            )
            vis.overlay_all_path = omr_result.debug_overlay_path

    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Không thể đọc file ảnh: {exc}",
        )
    except Exception as exc:
        logger.exception(f"OMR engine failed for debug-grade upload {unique_name}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"OMR engine lỗi: {type(exc).__name__}: {exc}",
        )

    # ── 6. Build response ─────────────────────────────────────────────────
    is_custom = _tpl_meta is not None
    if is_custom:
        # Custom template: use block-based extraction (no CUSTOM_LABEL_KEYS / MCQ_PREFIXES)
        student_info       = _extract_student_info_custom(omr_result, template)
        answers            = _extract_answers_custom(omr_result, template)
        info_field_columns = _build_info_field_columns_custom(omr_result, template)
        warnings           = (
            _extract_warnings_custom(omr_result, template)
            + _extract_info_warnings_custom(omr_result, template)
        )
    else:
        # VJU preset: use legacy CUSTOM_LABEL_KEYS / MCQ_PREFIXES extraction
        logger.info(
            "OMR custom_values keys: %s",
            {k: v[0] for k, v in omr_result.custom_values.items()},
        )
        student_info       = _extract_student_info(omr_result)
        answers            = _extract_answers(omr_result)
        info_field_columns = _build_info_field_columns(omr_result, template)
        info_warnings      = _extract_info_warnings(omr_result, template)
        warnings           = _extract_warnings(omr_result) + info_warnings

    score = _extract_score(omr_result)

    # original_image_path: relative path served under /uploads/...
    # e.g. "uploads/debug/abc123.jpg" → http://host:8000/uploads/debug/abc123.jpg
    original_image_path = str(save_path)

    # ── Alignment summary ─────────────────────────────────────────────────
    align_warnings = omr_result.warnings or []
    mr = omr_result.marker_result  # may be None if no markers found

    if omr_result.prep_method == "markers":
        stage = mr.prep_stage if mr else -1
        q_str = f", quality={mr.marker_quality_score:.2f}" if mr else ""
        stage_str = f" (stage={stage}{q_str})" if stage >= 0 else ""
        align_info = f"Đã căn chỉnh phối cảnh theo 4 marker góc{stage_str}"
    elif omr_result.prep_method == "croppage":
        align_info = "Đã cắt theo viền trang (không tìm thấy marker)"
    elif omr_result.prep_method == "fallback_no_warp":
        reason = mr.warp_rejected_reason if mr else ""
        align_info = f"Bỏ qua warp vì marker không đủ tin cậy ({reason})"
    else:
        align_info = "Không căn chỉnh được phối cảnh — dùng ảnh gốc"

    # Marker center info for frontend debug
    marker_centers_detected = (
        mr.marker_centers if mr and mr.marker_centers else None
    )
    homography = (
        mr.homography.tolist() if mr and mr.homography is not None else None
    )

    # Target marker centers come from template
    target_marker_centers = None
    try:
        if template.marker_centers_in_template:
            target_marker_centers = dict(template.marker_centers_in_template)
    except Exception:
        pass

    return {
        "input": {
            "filename":  image.filename,
            "saved_as":  original_image_path,
        },
        # ── Custom template metadata (non-null only when template_id was used) ──
        "template_id":   _tpl_meta["template_id"]   if _tpl_meta else None,
        "template_name": _tpl_meta["template_name"] if _tpl_meta else None,
        "template_type": _tpl_meta["template_type"] if _tpl_meta else (template_variant or "vju"),
        "student_info":       student_info,
        "answers":            answers,
        "warnings":           warnings,
        "info_field_columns": info_field_columns,
        "score":              score,
        "debug": {
            "threshold":                  round(omr_result.global_threshold, 2),
            "mean_mode":                  mean_mode,
            "prep_method":                omr_result.prep_method,
            "alignment_info":             align_info,
            "alignment_warnings":         align_warnings,
            "image_source":               omr_result.image_source,
            "preprocess_strategy_used":   omr_result.preprocess_strategy_used,
            # ── Marker calibration ────────────────────────────────────────
            "marker_centers_detected":    marker_centers_detected,
            "target_marker_centers":      target_marker_centers,
            "homography_matrix":          homography,
            # ── Quality gate ──────────────────────────────────────────────
            "marker_quality_score":       mr.marker_quality_score if mr else None,
            "warp_used":                  mr.warp_used if mr else None,
            "warp_rejected_reason":       mr.warp_rejected_reason if mr else None,
            # ── Per-source calibration ────────────────────────────────────
            "marker_centers_source_used":       mr.marker_centers_source_used if mr else None,
            "destination_marker_centers_used":  mr.destination_marker_centers_used if mr else None,
            "estimated_h_stretch":              mr.estimated_h_stretch if mr else None,
            # ── Phase 1/2 visual + read space ────────────────────────────
            "visual_aligned_mode":          omr_result.visual_aligned_mode,
            "visual_aligned_size":          list(omr_result.visual_aligned_size) if omr_result.visual_aligned_size else None,
            "visual_aligned_aspect_ratio":  omr_result.visual_aligned_aspect_ratio,
            "source_marker_aspect_ratio":   omr_result.source_marker_aspect_ratio,
            "template_aspect_ratio":        omr_result.template_aspect_ratio,
            "omr_read_space":               omr_result.omr_read_space,
            # ── 3 core images ─────────────────────────────────────────────
            "original_image_path":        original_image_path,
            "aligned_image_path":         vis.aligned_image_path,
            "aligned_candidate_path":     vis.aligned_candidate_path,
            "overlay_all_path":           vis.overlay_all_path,
            "markers_debug_path":         vis.markers_debug_path,
            # ── Extra debug (kept for scripts / OmrDebugPage) ─────────────
            "overlay_marked_only_path":   vis.overlay_marked_only_path,
            "overlay_warnings_path":      vis.overlay_warnings_path,
            "means_json_path":            vis.means_json_path,
        },
    }
