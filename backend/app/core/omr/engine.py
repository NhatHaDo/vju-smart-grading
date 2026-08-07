"""
engine.py
=========
OMR pipeline orchestrator — mirrors OMRChecker's processing order.

Pipeline (matches SVG diagram):
  1. Load image → grayscale
  2. Preprocess (priority: CropOnMarkers → CropPage → no-crop fallback)
  3. Resize to template pageDimensions [2550, 3301]
  4. Collect ALL bubble mean values (cv2.mean per ROI)
  5. Compute global threshold (largest-gap algorithm)
  6. For each fieldBlock → for each fieldLabel (strip):
       a. Extract ROI strip
       b. Compute local threshold (per-strip, fallback global)
       c. Classify bubbles (mean < thr → MARKED)
       d. Read field result (MCQ / INT dispatch)
  7. Aggregate customLabels
  8. (Optional) Score
  9. (Optional) Save debug overlay on full pageDimensions image
  10. Return OMRResult

Usage:
    engine = OMREngine(template)
    result = engine.run("sheet.jpg", answer_key={"toan1": "A", ...})
"""

from __future__ import annotations

import logging
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Union

import cv2
import numpy as np

from app.core.omr.bubble_analyzer import (
    CONFIDENT_SURPLUS,
    GLOBAL_DEFAULT_THR,
    MCQ_OUTLIER_MIN_JUMP,
    apply_center_fill_guard,
    classify_strip,
    classify_strip_int,
    get_global_threshold,
    get_local_threshold,
    measure_roi,
    measure_roi_with_center,
)
from app.core.omr.crop_on_markers import (
    crop_on_markers,
    create_visual_rectified_keep_aspect,
    draw_markers_debug,
    MarkerResult,
)
try:
    from app.core.omr.debug_overlay import (
        draw_overlay_marked_only,
        draw_overlay_projected,
        draw_overlay_warnings,
        draw_section_score_summary,
        draw_template_overlay,
        save_overlay,
    )
    _DEBUG_OVERLAY_AVAILABLE = True
except ModuleNotFoundError:
    _DEBUG_OVERLAY_AVAILABLE = False

    def _overlay_disabled_return_image(image, *args, **kwargs):
        return image

    def _overlay_disabled_save(*args, **kwargs):
        return None

    draw_template_overlay = _overlay_disabled_return_image
    draw_overlay_marked_only = _overlay_disabled_return_image
    draw_overlay_projected = _overlay_disabled_return_image
    draw_overlay_warnings = _overlay_disabled_return_image
    draw_section_score_summary = _overlay_disabled_return_image
    save_overlay = _overlay_disabled_save
from app.core.omr.field_reader import (
    FieldResult,
    FieldStatus,
    aggregate_custom_label,
    aggregate_signed_decimal,
    read_field,
)
from app.core.omr.preprocessor import (
    CropPageResult,
    crop_page,
    flatten_illumination,
    resize_fit_pad,
    resize_to_template,
)
from app.core.omr.roi_extractor import extract_roi, extract_roi_expanded, extract_roi_inverse, extract_region_inverse
from app.core.omr.scorer import GradingReport, score
from app.core.omr.signature_detector import SignatureCheck, detect_signatures
from app.core.templates.template_loader import VJUTemplate

logger = logging.getLogger(__name__)


# ── Image source type ─────────────────────────────────────────────────────

VALID_IMAGE_SOURCES = {"auto", "flatbed", "scan_app", "camera"}

# ── Per-source preprocessing strategy ────────────────────────────────────

@dataclass
class PreprocessStrategy:
    min_warp_quality: float
    enable_denoise: bool
    description: str

IMAGE_SOURCE_STRATEGIES: dict[str, PreprocessStrategy] = {
    "auto": PreprocessStrategy(
        min_warp_quality=0.45,
        enable_denoise=False,
        description="Tự động — warp threshold mặc định",
    ),
    "flatbed": PreprocessStrategy(
        min_warp_quality=0.65,
        enable_denoise=False,
        description="Scan máy — ưu tiên crop/resize nhẹ, warp chỉ khi marker rõ",
    ),
    "scan_app": PreprocessStrategy(
        min_warp_quality=0.55,
        enable_denoise=False,
        description="Scan app — ảnh đã crop/perspective sẵn, warp nhẹ",
    ),
    "camera": PreprocessStrategy(
        min_warp_quality=0.35,
        enable_denoise=True,
        description="Camera điện thoại — bật denoise, ưu tiên marker warp",
    ),
}


# ── Preprocessing method enum ─────────────────────────────────────────────

class PrepMethod:
    MARKERS          = "markers"           # CropOnMarkers + warp quality gate passed
    CROPPAGE         = "croppage"          # CropPage fallback
    FALLBACK_NO_WARP = "fallback_no_warp"  # markers detected but warp quality too low
    NONE             = "none"              # no crop applied


# ── Debug visual output paths ─────────────────────────────────────────────

@dataclass
class DebugVisualPaths:
    """Paths of all debug images / data produced by run_full_debug()."""
    aligned_image_path:        str | None = None   # final image used for OMR (after quality gate)
    aligned_candidate_path:    str | None = None   # warp output even when quality gate rejected it
    overlay_all_path:          str | None = None
    overlay_marked_only_path:  str | None = None
    overlay_warnings_path:     str | None = None
    means_json_path:           str | None = None
    markers_debug_path:        str | None = None   # annotated original with detected markers
    name_dob_crop_path:        str | None = None   # crop of "Họ và tên"/"Ngày sinh" info box (2026-08-06)


# ── Result container ──────────────────────────────────────────────────────

@dataclass
class OMRResult:
    field_results: dict[str, FieldResult]
    custom_values: dict[str, tuple[str, FieldStatus]]
    grading_report: GradingReport | None = None
    prep_method: str = PrepMethod.NONE
    global_threshold: float = GLOBAL_DEFAULT_THR
    debug_overlay_path: str | None = None
    warnings: list[str] = field(default_factory=list)
    marker_result: MarkerResult | None = None   # from CropOnMarkers step
    image_source: str = "auto"
    preprocess_strategy_used: str = ""
    # ── Phase 1: visual display mode ─────────────────────────────────────
    # "warp"                    — aligned_image is the warp/stretch to pageDimensions (may be distorted)
    # "original_no_stretch"     — aligned_image is resize_fit_pad of original (legacy, no H-stretch)
    # "rectified_keep_aspect"   — aligned_image is a flat warp at natural marker AR (no template stretch)
    visual_aligned_mode: str = "warp"
    # ── Phase 1: visual image size and aspect ratios (debug) ─────────────
    visual_aligned_size: tuple[int, int] | None = None          # (w, h) of the visual aligned image
    visual_aligned_aspect_ratio: float | None = None            # w/h of the visual aligned image
    source_marker_aspect_ratio: float | None = None             # natural w/h from marker distances
    template_aspect_ratio: float | None = None                  # pageDimensions[0]/pageDimensions[1]
    # ── Phase 2: OMR read space ───────────────────────────────────────────
    # "warped_page_dimensions" — bubbles read at template (x,y) from warped image
    # "inverse_h_original"     — bubbles read via M_inv projection from original image
    omr_read_space: str = "warped_page_dimensions"
    # Inverse homography (template → original image). Set when omr_read_space=="inverse_h_original".
    _M_inv: np.ndarray | None = field(default=None, repr=False)
    # ── "Ký tên giám thị/chấm thi" (2026-07-30) ───────────────────────────
    # Only populated when OMREngine(check_signatures=True) — i.e. fixed VJU
    # presets only, never custom templates (no guaranteed layout there).
    signature_checks: list[SignatureCheck] | None = None

    @property
    def needs_review(self) -> bool:
        return any(
            r.status in (FieldStatus.MULTI_MARK, FieldStatus.TOO_LIGHT, FieldStatus.NEEDS_REVIEW)
            for r in self.field_results.values()
        )

    def to_dict(self) -> dict:
        return {
            "field_results": {
                k: {
                    "selected_value": v.selected_value,
                    "selected_values": v.selected_values,
                    "status": v.status.value,
                }
                for k, v in self.field_results.items()
            },
            "custom_values": {
                k: {"value": val, "status": st.value}
                for k, (val, st) in self.custom_values.items()
            },
            "grading_report": (
                {
                    "total_score": self.grading_report.total_score,
                    "max_score": self.grading_report.max_score,
                    "percentage": self.grading_report.percentage,
                    "needs_review": self.grading_report.needs_review,
                }
                if self.grading_report else None
            ),
            "prep_method": self.prep_method,
            "global_threshold": self.global_threshold,
            "warnings": self.warnings,
        }


# ── Engine ────────────────────────────────────────────────────────────────

class OMREngine:
    def __init__(
        self,
        template: VJUTemplate,
        enable_crop: bool = True,
        debug_overlay_dir: str | Path | None = None,
        mean_mode: str = "circle_mask",
        signature_box_set: str | None = None,
        enable_illumination_flatten: bool = True,
    ):
        """
        Args:
            template:          Parsed VJUTemplate.
            enable_crop:       If False, skip all preprocessing (useful for debug).
            debug_overlay_dir: Auto-save overlay here after every run() call.
            mean_mode:         "circle_mask" (default) or "rect".
                               circle_mask avoids grid lines and digit borders.
            signature_box_set: Detect ink presence in the "CÁN BỘ COI THI"/
                               "CÁN BỘ CHẤM THI" boxes (see signature_detector.py)
                               using this calibrated box set — e.g. "vju_main"
                               or "mau40". None (default) skips detection
                               entirely. Only pass a value for templates that
                               actually have a registered box set — the
                               calibrated coordinates assume that exact page
                               layout and are meaningless on anything else.
            enable_illumination_flatten: Flatten uneven page lighting (see
                               flatten_illumination() in preprocessor.py)
                               right before bubble reading, whenever the
                               sheet was aligned via marker-warp (prep_
                               method == "markers" — i.e. almost always for
                               phone photos, regardless of the largely-unused
                               image_source parameter). Deliberately NOT
                               gated on image_source: grading_service.py
                               (the real production call site) and
                               QuickGradePage.tsx's captureAndGrade() both
                               always pass image_source="auto" (confirmed by
                               reading both call sites), so a source=="camera"
                               gate would silently never fire in production —
                               same dead-code trap as the Phase 1 visual fix
                               earlier this project. Set False to reproduce
                               pre-2026-08-06 behavior exactly (used by the
                               regression-comparison script).
        """
        self.template = template
        self.enable_crop = enable_crop
        self.enable_illumination_flatten = enable_illumination_flatten
        self.debug_overlay_dir = Path(debug_overlay_dir) if debug_overlay_dir else None
        self.mean_mode = mean_mode
        self.signature_box_set = signature_box_set
        self._morph_kernel: tuple[int, int] = (10, 10)
        self._target_size = tuple(template.page_dimensions)  # (w, h)

    # ── Public API ────────────────────────────────────────────────────────

    def run(
        self,
        image_input: Union[str, Path, np.ndarray],
        # dict[str, str] for single-đề exams (flat {label: letter}), or
        # {"byMaDe": {ma_de: {label: letter}}, "default": {...}} for
        # multi-mã-đề exams — resolved against the detected mã đề in Step 8
        # of _execute() before scoring (2026-08-03).
        answer_key: dict | None = None,
        section_labels: dict[str, list[str]] | None = None,
        points_per_question: float = 1.0,
        question_points: dict[str, float] | None = None,
        wrong_points: float = 0.0,
        blank_points: float = 0.0,
        debug_filename: str | None = None,
        image_source: str = "auto",
    ) -> OMRResult:
        """Full OMR pipeline. Returns OMRResult."""
        omr_result, _aligned, _means, _visual = self._execute(
            image_input,
            answer_key=answer_key,
            section_labels=section_labels,
            points_per_question=points_per_question,
            question_points=question_points,
            wrong_points=wrong_points,
            blank_points=blank_points,
            image_source=image_source,
        )

        # Optional overlay (single, same as before) — always on warped image for run()
        overlay_path: str | None = None
        if (self.debug_overlay_dir or debug_filename) and _aligned is not None:
            overlay_path = self._save_overlay(
                _aligned, omr_result.field_results, debug_filename
            )
        omr_result.debug_overlay_path = overlay_path
        return omr_result

    def run_full_debug(
        self,
        image_input: Union[str, Path, np.ndarray],
        output_dir: str | Path,
        prefix: str = "debug",
        # dict[str, str] for single-đề exams (flat {label: letter}), or
        # {"byMaDe": {ma_de: {label: letter}}, "default": {...}} for
        # multi-mã-đề exams — resolved against the detected mã đề in Step 8
        # of _execute() before scoring (2026-08-03).
        answer_key: dict | None = None,
        section_labels: dict[str, list[str]] | None = None,
        points_per_question: float = 1.0,
        question_points: dict[str, float] | None = None,
        wrong_points: float = 0.0,
        blank_points: float = 0.0,
        block_filter: str | None = None,
        image_source: str = "auto",
    ) -> tuple[OMRResult, DebugVisualPaths]:
        """
        Run the full OMR pipeline and save all 4 debug images + means JSON.

        Outputs (all in output_dir/):
          {prefix}_aligned_by_markers.jpg   — image after warp/crop + resize
          {prefix}_overlay_all.jpg          — all ROIs coloured by status
          {prefix}_overlay_marked_only.jpg  — only marked bubbles, RED circle + label
          {prefix}_overlay_warnings.jpg     — only warning bubbles, orange/yellow
          {prefix}_means.json               — per-bubble detail table

        Args:
            image_input:   Path string, Path, or numpy array.
            output_dir:    Directory to save all outputs.
            prefix:        Filename prefix (default "debug").
            answer_key:    Optional {field_label: correct_answer}.
            section_labels:Optional section groupings for scoring — auto-detected
                            via `_auto_detect_phan_sections()` when left None and
                            the template matches a known field-naming convention
                            (see that method's docstring).
            question_points, wrong_points, blank_points: see scorer.score().
            block_filter:  If set, marked_only/warnings overlays show only this block.

        Returns:
            (OMRResult, DebugVisualPaths)
        """
        import json as _json

        out = Path(output_dir)
        out.mkdir(parents=True, exist_ok=True)

        # ── Run pipeline ──────────────────────────────────────────────────
        omr_result, aligned_image, bubble_means, visual_image = self._execute(
            image_input,
            answer_key=answer_key,
            section_labels=section_labels,
            points_per_question=points_per_question,
            question_points=question_points,
            wrong_points=wrong_points,
            blank_points=blank_points,
            image_source=image_source,
        )

        vis = DebugVisualPaths()

        if aligned_image is None:
            logger.error("run_full_debug: aligned_image is None — cannot save debug outputs")
            return omr_result, vis

        # 2026-08-03: per-question correctness for the "Ảnh detect" overlay
        # (green=đúng / red=sai / yellow=câu lỗi) — only populated when an
        # answer key was supplied and successfully resolved (see Step 8 in
        # _execute()); otherwise None, and the overlay keeps its original
        # always-green appearance for a clean answer.
        correctness: dict[str, bool] | None = None
        if omr_result.grading_report is not None:
            correctness = {
                q.field_label: q.is_correct
                for q in omr_result.grading_report.questions
            }

        # ── 1. Aligned image ──────────────────────────────────────────────
        # Phase 1: when visual_image is set (scan_app + high h_stretch), save the
        # non-distorted fit_pad image as the display image instead of the warp output.
        # aligned_image (warped) is still used for overlay drawing (Phase 2 will change this).
        display_image = visual_image if visual_image is not None else aligned_image
        aligned_path = out / f"{prefix}_aligned_by_markers.jpg"
        try:
            if len(display_image.shape) == 2:
                save_img = cv2.cvtColor(display_image, cv2.COLOR_GRAY2BGR)
            else:
                save_img = display_image
            cv2.imwrite(str(aligned_path), save_img, [cv2.IMWRITE_JPEG_QUALITY, 92])
            vis.aligned_image_path = str(aligned_path)
            logger.info(
                f"Saved aligned image → {aligned_path} "
                f"(mode={omr_result.visual_aligned_mode})"
            )
        except Exception as e:
            logger.warning(f"Failed to save aligned image: {e}")

        # ── 1b. Aligned candidate (warp output even if quality gate rejected it) ──
        mr = omr_result.marker_result
        if mr is not None and not mr.warp_used and mr.warp_candidate_image is not None:
            try:
                cand_img = mr.warp_candidate_image
                if len(cand_img.shape) == 2:
                    cand_img = cv2.cvtColor(cand_img, cv2.COLOR_GRAY2BGR)
                cand_path = out / f"{prefix}_aligned_candidate.jpg"
                cv2.imwrite(str(cand_path), cand_img, [cv2.IMWRITE_JPEG_QUALITY, 92])
                vis.aligned_candidate_path = str(cand_path)
                logger.info(f"Saved aligned_candidate → {cand_path}")
            except Exception as e:
                logger.warning(f"Failed to save aligned_candidate: {e}")

        # Build per-block expand_px map for overlay drawing
        block_expand_px = {
            block.name: block.roi_expand_px
            for block in self.template.field_blocks
            if block.roi_expand_px > 0
        }

        # Determine overlay mode: inverse-H projected vs standard warped
        _use_projected = (
            omr_result.omr_read_space == "inverse_h_original"
            and omr_result._M_inv is not None
        )

        # For projected overlays, draw on the original (non-warped) raw image.
        # Re-loading here is cheap; avoids holding a second large array in memory.
        _raw_for_overlay: np.ndarray | None = None
        if _use_projected:
            try:
                _raw_for_overlay = self._load_image(image_input)
            except Exception as _e:
                logger.warning(f"run_full_debug: failed to load raw image for projected overlay: {_e}")
                _use_projected = False  # fall back to standard overlays

        # ── 2. overlay_all ────────────────────────────────────────────────
        try:
            if _use_projected and _raw_for_overlay is not None:
                img_all = draw_overlay_projected(
                    _raw_for_overlay, self.template, omr_result._M_inv,
                    field_results=omr_result.field_results,
                    bubble_means=bubble_means,
                    block_expand_px=block_expand_px or None,
                    correctness=correctness,
                )
            else:
                img_all = draw_template_overlay(
                    aligned_image, self.template,
                    field_results=omr_result.field_results,
                    bubble_means=bubble_means,
                    draw_mode="both",
                    block_expand_px=block_expand_px or None,
                    correctness=correctness,
                )
            # Tóm tắt điểm từng Phần (P1/P2/P3 + Tổng), kiểu chấm bút đỏ —
            # chỉ vẽ khi có grading_report VÀ có sections (tức có đáp án +
            # template khớp quy ước tên field đã biết, xem
            # _auto_detect_phan_sections()); im lặng bỏ qua nếu không.
            gr = omr_result.grading_report
            if gr is not None and gr.sections:
                img_all = draw_section_score_summary(
                    img_all, gr.sections, gr.total_score, gr.max_score,
                )
            p = save_overlay(img_all, out / f"{prefix}_overlay_all.jpg")
            vis.overlay_all_path = str(p)
            logger.info(f"Saved overlay_all → {p} (projected={_use_projected})")
        except Exception as e:
            # 2026-07-29: logger.warning() alone was silently going nowhere in
            # production (app logger got no output at all — separate logging
            # config issue), which made this failure invisible for weeks.
            # print() bypasses logging entirely and is guaranteed to land in
            # the nohup-redirected log file regardless of logger config.
            print(f"[run_full_debug] overlay_all FAILED: {type(e).__name__}: {e}", flush=True)
            traceback.print_exc()
            logger.warning(f"overlay_all failed: {e}")

        # ── 3. overlay_marked_only ────────────────────────────────────────
        try:
            if _use_projected and _raw_for_overlay is not None:
                img_marked = draw_overlay_projected(
                    _raw_for_overlay, self.template, omr_result._M_inv,
                    field_results=omr_result.field_results,
                    bubble_means=bubble_means,
                    block_expand_px=block_expand_px or None,
                )
            else:
                img_marked = draw_overlay_marked_only(
                    aligned_image, self.template,
                    field_results=omr_result.field_results,
                    bubble_means=bubble_means,
                    block_filter=block_filter,
                    block_expand_px=block_expand_px or None,
                )
            p = save_overlay(img_marked, out / f"{prefix}_overlay_marked_only.jpg")
            vis.overlay_marked_only_path = str(p)
            logger.info(f"Saved overlay_marked_only → {p} (projected={_use_projected})")
        except Exception as e:
            print(f"[run_full_debug] overlay_marked_only FAILED: {type(e).__name__}: {e}", flush=True)
            traceback.print_exc()
            logger.warning(f"overlay_marked_only failed: {e}")

        # ── 4. overlay_warnings ───────────────────────────────────────────
        try:
            if _use_projected and _raw_for_overlay is not None:
                img_warn = draw_overlay_projected(
                    _raw_for_overlay, self.template, omr_result._M_inv,
                    field_results=omr_result.field_results,
                    bubble_means=bubble_means,
                    block_expand_px=block_expand_px or None,
                )
            else:
                img_warn = draw_overlay_warnings(
                    aligned_image, self.template,
                    field_results=omr_result.field_results,
                    bubble_means=bubble_means,
                    block_filter=block_filter,
                    block_expand_px=block_expand_px or None,
                )
            p = save_overlay(img_warn, out / f"{prefix}_overlay_warnings.jpg")
            vis.overlay_warnings_path = str(p)
            logger.info(f"Saved overlay_warnings → {p} (projected={_use_projected})")
        except Exception as e:
            print(f"[run_full_debug] overlay_warnings FAILED: {type(e).__name__}: {e}", flush=True)
            traceback.print_exc()
            logger.warning(f"overlay_warnings failed: {e}")

        # ── 5. means.json ────────────────────────────────────────────────
        try:
            means_list = self._build_means_json(
                omr_result.field_results, bubble_means or {}
            )
            means_path = out / f"{prefix}_means.json"
            means_path.write_text(
                _json.dumps(means_list, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            vis.means_json_path = str(means_path)
            logger.info(f"Saved means.json → {means_path} ({len(means_list)} entries)")
        except Exception as e:
            logger.warning(f"means.json failed: {e}")

        # ── 6. Markers debug image (annotated original) ───────────────────
        if mr is not None:
            try:
                # Re-load original raw image (pre-alignment) for annotation
                raw_for_debug = self._load_image(image_input)
                markers_vis = draw_markers_debug(raw_for_debug, mr)
                markers_path = out / f"{prefix}_markers_debug.jpg"
                if len(markers_vis.shape) == 2:
                    markers_vis = cv2.cvtColor(markers_vis, cv2.COLOR_GRAY2BGR)
                cv2.imwrite(str(markers_path), markers_vis, [cv2.IMWRITE_JPEG_QUALITY, 88])
                vis.markers_debug_path = str(markers_path)
                logger.info(f"Saved markers_debug → {markers_path}")
            except Exception as e:
                logger.warning(f"markers_debug failed: {e}")

        # ── 7. Name/DOB crop ("Họ và tên" / "Ngày sinh") ───────────────────
        # See _get_name_dob_crop_box() docstring-comment above for why this
        # region is hardcoded and template-restricted. Prefers cropping via
        # M_inv from the original (un-warped) image — same source used for
        # the projected overlays above — so the handwriting stays at native
        # photo resolution instead of being blurred by the pageDimensions
        # warp; falls back to cropping aligned_image directly when M_inv
        # isn't available (matches _use_projected's own fallback).
        crop_box = self._get_name_dob_crop_box()
        if crop_box is not None:
            try:
                cx1, cy1, cx2, cy2 = crop_box
                if _use_projected and omr_result._M_inv is not None:
                    _src = _raw_for_overlay if _raw_for_overlay is not None else self._load_image(image_input)
                    name_dob_img = extract_region_inverse(
                        _src, cx1, cy1, cx2 - cx1, cy2 - cy1, omr_result._M_inv,
                    )
                else:
                    name_dob_img = aligned_image[cy1:cy2, cx1:cx2]
                if name_dob_img is not None and name_dob_img.size > 0:
                    if len(name_dob_img.shape) == 2:
                        name_dob_img = cv2.cvtColor(name_dob_img, cv2.COLOR_GRAY2BGR)
                    crop_path = out / f"{prefix}_name_dob_crop.jpg"
                    cv2.imwrite(str(crop_path), name_dob_img, [cv2.IMWRITE_JPEG_QUALITY, 92])
                    vis.name_dob_crop_path = str(crop_path)
                    logger.info(f"Saved name_dob_crop → {crop_path} (projected={_use_projected})")
            except Exception as e:
                logger.warning(f"name_dob_crop failed: {e}")

        # Also set the main overlay_path on the result for backward compat
        omr_result.debug_overlay_path = vis.overlay_all_path
        return omr_result, vis

    # 2026-08-06: yêu cầu hiện tóm tắt điểm từng "Phần" vật lý trên phiếu
    # (Phần I-II / Phần III Đúng-Sai / Phần IV điền số) in trực tiếp lên ảnh
    # overlay kết quả, kiểu chấm bút đỏ. File template JSON không có khái
    # niệm "Phần" nào lưu sẵn (đã kiểm tra shared_40tn_dungsai.template.json
    # — chỉ có fieldBlocks/compositeAnswerFields, không có key "section" hay
    # "phan" nào) nên đoán theo đúng quy ước đặt tên field của mẫu phiếu này:
    #   - "trc_nghim_abcd*"  → Phần I-II (trắc nghiệm 4 đáp án)
    #   - "ng_sai_cu*"       → Phần III (Đúng/Sai)
    #   - field composite (số, trong compositeAnswerFields) → Phần IV
    # Chỉ áp dụng khi template khớp ít nhất 1 trong 3 quy ước trên — trả về
    # None cho mẫu phiếu khác để không gắn nhãn sai.
    def _auto_detect_phan_sections(self) -> dict[str, list[str]] | None:
        p1 = [l for l in self.template.all_labels if l.startswith("trc_nghim_abcd")]
        p2 = [l for l in self.template.all_labels if l.startswith("ng_sai_cu")]
        p3 = list(self.template.composite_answer_fields.keys())
        if not p1 and not p2 and not p3:
            return None
        sections: dict[str, list[str]] = {}
        if p1:
            sections["Phần I-II"] = p1
        if p2:
            sections["Phần III"] = p2
        if p3:
            sections["Phần IV"] = p3
        return sections

    # 2026-08-06: yêu cầu thêm ảnh cắt riêng vùng "2. Họ và tên" + "3. Ngày
    # sinh" (viết tay) vào kết quả, hiển thị ở trang Kết quả — người dùng
    # chọn phương án chỉ cắt ảnh để người chấm tự đọc bằng mắt (không OCR,
    # vì nhận diện chữ viết tay tiếng Việt không đủ tin cậy). Template hiện
    # tại không định nghĩa vùng ROI riêng cho "Họ và tên"/"Ngày sinh" (chỉ
    # có "Mã Sinh Viên" dạng tô bubble — xem _auto_detect_phan_sections() ở
    # trên), nên toạ độ dưới đây được đo thủ công bằng cách crop-thử trên 1
    # ảnh aligned thật (1000×1414, đúng pageDimensions của
    # shared_40tn_dungsai) lấy từ 1 phiếu scan thật trong DB, khớp đúng 2
    # dòng "2. Họ và tên:" và "3. Ngày sinh:" trong khung thông tin bên
    # trái phiếu (đã xác nhận bằng mắt qua ảnh crop, không đoán). Chỉ áp
    # dụng cho template khớp quy ước đặt tên field của shared_40tn_dungsai
    # (cùng điều kiện với _auto_detect_phan_sections) VÀ đúng pageDimensions
    # đã đo — trả về None cho mọi template khác để không cắt sai vùng.
    # 2026-08-06: box rộng hơn mức tối thiểu đo được (170,210)-(755,340) —
    # cố ý thêm biên margin ~15-20px mỗi phía để chịu được sai lệch nhỏ giữa
    # các lần scan/chụp khác nhau (góc nghiêng, marker_quality thấp...) vẫn
    # có thể làm nội dung xê dịch vài chục px trong khung 1000×1414 dù đã
    # warp theo marker — cùng hạn chế đã biết với phần overlay bubble-đọc,
    # xem ghi chú "marker quality thấp" ở _execute(). Không phải lỗi phần
    # cắt ảnh; ảnh gốc/đã căn chỉnh vẫn xem được ở tab riêng khi crop lệch.
    _NAME_DOB_CROP_BOX = (150, 190, 770, 350)  # (x1, y1, x2, y2) tại pageDimensions 1000×1414

    def _get_name_dob_crop_box(self) -> tuple[int, int, int, int] | None:
        p1 = [l for l in self.template.all_labels if l.startswith("trc_nghim_abcd")]
        if not p1:
            return None
        tpl_w, tpl_h = self.template.page_dimensions
        if (tpl_w, tpl_h) != (1000, 1414):
            return None
        return self._NAME_DOB_CROP_BOX

    # ── Internal pipeline ─────────────────────────────────────────────────

    # Minimum estimated H-stretch (%) that triggers Phase 1 visual fix
    _VISUAL_FIX_H_STRETCH_THRESHOLD = 8.0

    def _execute(
        self,
        image_input: Union[str, Path, np.ndarray],
        # dict[str, str] for single-đề exams (flat {label: letter}), or
        # {"byMaDe": {ma_de: {label: letter}}, "default": {...}} for
        # multi-mã-đề exams — resolved against the detected mã đề in Step 8
        # of _execute() before scoring (2026-08-03).
        answer_key: dict | None = None,
        section_labels: dict[str, list[str]] | None = None,
        points_per_question: float = 1.0,
        question_points: dict[str, float] | None = None,
        wrong_points: float = 0.0,
        blank_points: float = 0.0,
        image_source: str = "auto",
    ) -> tuple[OMRResult, np.ndarray | None, dict[str, float] | None, np.ndarray | None]:
        """
        Core OMR pipeline.
        Returns (OMRResult, omr_image, bubble_means, visual_image).

        omr_image:    preprocessed + resized to pageDimensions — used for OMR reading.
        visual_image: non-distorted image for display (resize_fit_pad of original when
                      scan_app + h_stretch > threshold), or None (use omr_image for display).
        bubble_means: {"label:value": float}.
        """
        warnings: list[str] = []

        src = image_source if image_source in VALID_IMAGE_SOURCES else "auto"
        strategy = IMAGE_SOURCE_STRATEGIES[src]
        logger.info(f"OMR: image_source={src}, strategy={strategy.description}")

        # ── Step 1: Load ──────────────────────────────────────────────────
        raw = self._load_image(image_input)
        orig_h, orig_w = raw.shape[:2]
        logger.info(f"OMR: loaded image {orig_w}×{orig_h}")

        # ── Step 1b: Denoise for camera images ───────────────────────────
        if strategy.enable_denoise:
            raw = cv2.fastNlMeansDenoising(raw, None, h=7, templateWindowSize=7, searchWindowSize=21)
            logger.info("OMR: applied fastNlMeansDenoising (camera mode)")

        # ── Step 2: Preprocess ────────────────────────────────────────────
        image, prep_method, _marker_result = self._preprocess(
            raw, warnings, min_warp_quality=strategy.min_warp_quality,
            image_source=src,
        )

        # Camera-specific: warn if marker quality is low
        if src == "camera" and _marker_result is not None:
            if not _marker_result.warp_used and _marker_result.marker_quality_score < strategy.min_warp_quality:
                warnings.append(
                    f"Camera: marker quality thấp ({_marker_result.marker_quality_score:.2f}) — "
                    "cần căn chỉnh thủ công hoặc chụp lại ảnh rõ hơn"
                )

        # Build strategy description for response
        strategy_parts = [src]
        if strategy.enable_denoise:
            strategy_parts.append("denoise")
        strategy_parts.append(f"warp_threshold={strategy.min_warp_quality}")
        strategy_parts.append(prep_method)
        preprocess_strategy_used = " → ".join(strategy_parts)

        # ── Step 3: Resize to pageDimensions ─────────────────────────────
        image = resize_to_template(image, self.template.page_dimensions)
        page_w, page_h = image.shape[1], image.shape[0]
        logger.info(f"OMR: resized to {page_w}×{page_h} (template dims)")
        aligned_image = image  # capture for OMR reading (always pageDimensions)

        # ── "Ký tên giám thị/chấm thi" ────────────────────────────────────
        # Runs on aligned_image specifically (grayscale, resized to
        # template pageDimensions) — the exact coordinate space the
        # calibrated signature boxes were measured in. Only for fixed VJU
        # presets (see check_signatures docstring in __init__).
        signature_checks: list[SignatureCheck] | None = None
        if self.signature_box_set:
            try:
                signature_checks = detect_signatures(aligned_image, box_set=self.signature_box_set)
            except Exception as exc:
                logger.warning(f"OMR: signature detection failed — {exc}")

        # ── Phase 1 visual fix ────────────────────────────────────────────
        # For significant H-stretch: produce a flat, AR-preserving display
        # image by warping to the natural marker-measured rectangle. The OMR
        # read path (Phase 2) remains unaffected — it reads via M_inv from
        # the original image regardless of which visual image is shown.
        #
        # 2026-08-04: was gated to `src == "scan_app"` only — but
        # grading_service.py (the real production grading call) NEVER passes
        # image_source at all, so `src` is ALWAYS "auto" for every real
        # request regardless of how the photo was taken. That made this
        # entire Phase1/Phase2 fix dead code in production. Confirmed via a
        # real camera-captured photo (h_stretch=11.1%, marker_quality=0.875,
        # warp_used=True — a technically-successful warp that's still
        # visually a trapezoid, because a 4-point homography exactly anchors
        # the markers but doesn't force the rest of the page level when the
        # source quadrilateral is this keystoned): "sao ảnh thẳng thế kia mà
        # cái ảnh detect nó chuyển sang méo mó, hình thang vậy". The fix
        # itself (create_visual_rectified_keep_aspect, warping to the
        # marker's OWN natural rectangle instead of forcing template AR) was
        # already built and already produces a correctly flat result — it
        # just never ran for camera/auto photos. h_stretch is a purely
        # geometric property of the photo, unrelated to which capture UI
        # produced it, so drop the source restriction entirely and let the
        # h_stretch threshold (the real signal) decide.
        visual_image: np.ndarray | None = None
        visual_aligned_mode = "warp"
        visual_aligned_size: tuple[int, int] | None = None
        visual_aligned_aspect_ratio: float | None = None
        source_marker_aspect_ratio: float | None = None

        # Compute template AR once (pageDimensions)
        tpl_w, tpl_h = self.template.page_dimensions
        template_aspect_ratio = round(tpl_w / tpl_h, 4) if tpl_h > 0 else None

        mr_for_stretch = _marker_result
        h_stretch_estimate = mr_for_stretch.estimated_h_stretch if mr_for_stretch is not None else None

        # 2026-08-05: estimated_h_stretch is only ever populated by
        # _preprocess() when the template ships an explicit
        # cropOnMarkersConfig.markerCentersInTemplate ("correct mode") — see
        # engine.py's _preprocess(), the assignment is nested inside
        # `if marker_tpl_centers is not None:`. Custom/shared templates
        # compiled without that block (confirmed: shared_40tn_dungsai —
        # the "Mẫu 40 câu TN + Đúng/Sai" template, used for real camera
        # gradings and reported as "lệch tùm lum, ảnh méo mó") warp in
        # "legacy" mode instead, where estimated_h_stretch stays None
        # forever — so Phase 1 below never triggered for them even when the
        # source photo was heavily keystoned (confirmed: one real photo had
        # a 142px horizontal drift between its TL/BL marker corners vs ~37px
        # for a well-aligned shot of the same template — genuine tilt, not
        # noise). Fix: when the precomputed value is missing, derive the
        # same ratio directly from marker_pts vs template pageDimensions.
        # This is not an approximation — in legacy mode the warp destination
        # IS exactly the page rectangle (0,0)-(w,0)-(w,h)-(0,h), so
        # dst_AR == template_aspect_ratio exactly, making this algebraically
        # identical to the "correct mode" formula in _preprocess(). Purely a
        # display-signal computation — does not touch classification/warp
        # math, so it carries no grading-accuracy risk.
        if (
            h_stretch_estimate is None
            and mr_for_stretch is not None
            and mr_for_stretch.marker_pts is not None
            and len(mr_for_stretch.marker_pts) == 4
            and template_aspect_ratio
        ):
            _pts = mr_for_stretch.marker_pts.astype(float)
            _src_h = (np.linalg.norm(_pts[1] - _pts[0]) + np.linalg.norm(_pts[2] - _pts[3])) / 2.0
            _src_v = (np.linalg.norm(_pts[3] - _pts[0]) + np.linalg.norm(_pts[2] - _pts[1])) / 2.0
            if _src_v > 0 and _src_h > 0:
                _src_ar = _src_h / _src_v
                h_stretch_estimate = round((template_aspect_ratio / _src_ar - 1.0) * 100, 2)

        if (
            mr_for_stretch is not None
            and h_stretch_estimate is not None
            and h_stretch_estimate > self._VISUAL_FIX_H_STRETCH_THRESHOLD
            and mr_for_stretch.marker_pts is not None
        ):
            try:
                rect_canvas, rect_w, rect_h = create_visual_rectified_keep_aspect(
                    raw, mr_for_stretch.marker_pts, margin=30
                )
                visual_image = rect_canvas
                visual_aligned_mode = "rectified_keep_aspect"
                visual_aligned_size = (rect_w, rect_h)
                visual_aligned_aspect_ratio = round(rect_w / rect_h, 4) if rect_h > 0 else None

                # Compute natural AR from marker distances (without margin)
                pts = mr_for_stretch.marker_pts.astype(float)
                nat_w = (np.linalg.norm(pts[1]-pts[0]) + np.linalg.norm(pts[2]-pts[3])) / 2.0
                nat_h = (np.linalg.norm(pts[3]-pts[0]) + np.linalg.norm(pts[2]-pts[1])) / 2.0
                source_marker_aspect_ratio = round(float(nat_w / nat_h), 4) if nat_h > 0 else None

                logger.info(
                    f"OMR Phase1: src={src} h_stretch={h_stretch_estimate:.1f}% "
                    f"→ rectified_keep_aspect {rect_w}×{rect_h} "
                    f"(marker_ar={source_marker_aspect_ratio}, tpl_ar={template_aspect_ratio})"
                )
            except Exception as exc:
                logger.warning(f"OMR Phase1: create_visual_rectified_keep_aspect failed — {exc}")

        # ── Phase 2 inverse-H read: compute M_inv when conditions are met ───
        # Condition: scan_app + warp applied + h_stretch > threshold + homography exists.
        #
        # 2026-08-04: UNLIKE Phase 1 above, this one is intentionally kept
        # scan_app-only (i.e. effectively never triggers, since production
        # never passes image_source) after testing it broadened the same way.
        # Reading bubbles via M_inv from the raw (un-warped) image sounds
        # like it should be strictly more accurate, but on the exact camera
        # photo that motivated this investigation it silently changed 4/89
        # field reads — including cccd9 and cccd10, which the ALREADY-WARP-
        # READ pipeline got right (confirmed against the archived, human-
        # reviewed overlay: "4" and "5", matching this student's actual CCCD
        # digits) — inverse_h_original flipped both of those two specific
        # correct answers to blank, while also "fixing" ptbv3/cnnn4 from
        # needs_review to a specific letter (unverified whether that's
        # actually right either). This read path was apparently never
        # exercised against a real photo in production before (same
        # scan_app-only gate as Phase 1), so this bug was latent and
        # untested. Do not broaden this condition without first finding and
        # fixing whatever makes extract_roi_inverse/M_inv disagree with the
        # proven warp-based read on real photos — grading correctness matters
        # far more than the visual straightness Phase 1 alone already fixes.
        M_inv: np.ndarray | None = None
        omr_read_space = "warped_page_dimensions"
        if (
            src == "scan_app"
            and _marker_result is not None
            and _marker_result.warp_used
            and _marker_result.estimated_h_stretch is not None
            and _marker_result.estimated_h_stretch > self._VISUAL_FIX_H_STRETCH_THRESHOLD
            and _marker_result.homography is not None
        ):
            try:
                M_inv = np.linalg.inv(_marker_result.homography)
                omr_read_space = "inverse_h_original"
                logger.info(
                    f"OMR Phase2: src={src} h_stretch={_marker_result.estimated_h_stretch:.1f}% "
                    f"→ reading bubbles via M_inv from original image"
                )
            except np.linalg.LinAlgError as exc:
                logger.warning(f"OMR Phase2: M_inv compute failed ({exc}) — fallback to warp read")

        # Select the read image: original (raw) for inverse-H, warped for standard
        read_image = raw if M_inv is not None else image

        # ── Illumination flattening (2026-08-06) ───────────────────────────
        # Only for the standard warp-read path, and only when marker-warp
        # actually ran (prep_method == "markers" — a real phone photo aligned
        # via the 4 corner markers). Applied to read_image only: does NOT
        # touch `aligned_image` (used for signature detection, above, and for
        # the saved aligned_image_path debug/display output) or `raw` (used
        # for marker detection, already done by this point) — scoped
        # strictly to what feeds bubble measurement, so blast radius is
        # limited to classification accuracy alone.
        illumination_flattened = False
        if self.enable_illumination_flatten and M_inv is None and prep_method == "markers":
            read_image = flatten_illumination(read_image)
            illumination_flattened = True
            logger.info("OMR: applied flatten_illumination() before bubble reading")

            # 2026-08-06: "đưa cái ảnh đó vào cái phần ảnh đã căn chỉnh đi
            # (của cả 3 mẫu phiếu luôn)" — also swap the debug/display
            # `aligned_image` (returned by _execute(), saved as
            # aligned_image_path, and reused as the background for the
            # overlay images) to the flattened version, so "Ảnh đã căn
            # chỉnh" in the UI shows what bubble-reading actually sees.
            # Safe to reassign here: signature detection already ran on the
            # original `aligned_image` above (line ~624) before this point,
            # so it's unaffected; nothing else reads the old `aligned_image`
            # between here and the function's return. Applies to every
            # template uniformly — this is engine-level, gated on
            # prep_method=="markers", not on which template/sheet design
            # was used.
            aligned_image = read_image

        # ── Steps 4-5: Collect all means → global threshold ───────────────
        all_mean_values: list[float] = []
        strip_means_index:        dict[tuple[str, str], list[float]] = {}
        strip_center_fills_index: dict[tuple[str, str], list[float]] = {}  # MCQ only (0–1)

        INT_FIELD_TYPES = {"QTYPE_INT_FROM_1", "QTYPE_INT"}

        for block in self.template.field_blocks:
            expand_px = block.roi_expand_px  # 0 = nominal box (no expansion)
            is_int    = block.field_type in INT_FIELD_TYPES
            for label in block.field_labels:
                bubbles = self.template.bubbles_by_label[label]
                if M_inv is not None:
                    rois = [extract_roi_inverse(read_image, b, M_inv, expand_px) for b in bubbles]
                else:
                    rois = [extract_roi_expanded(read_image, b, expand_px) for b in bubbles]

                if is_int:
                    # INT fields: single outer-circle mean (unchanged path)
                    strip_means = [measure_roi(roi, mean_mode=self.mean_mode) for roi in rois]
                else:
                    # MCQ fields: measure both outer and inner circle in one pass to
                    # detect ring-only false positives (bright centre = not truly filled).
                    pairs = [measure_roi_with_center(roi) for roi in rois]
                    strip_means   = [outer for outer, _inner in pairs]
                    center_fills  = [inner / 255.0 for _outer, inner in pairs]
                    strip_center_fills_index[(block.name, label)] = center_fills

                strip_means_index[(block.name, label)] = strip_means
                all_mean_values.extend(strip_means)

        global_thr = get_global_threshold(all_mean_values)
        logger.info(
            f"OMR: global threshold = {global_thr:.1f} "
            f"(from {len(all_mean_values)} bubble means)"
        )

        # ── Step 6: Per-strip classification + field reading ──────────────
        field_results: dict[str, FieldResult] = {}

        for block in self.template.field_blocks:
            is_int = block.field_type in INT_FIELD_TYPES
            for label in block.field_labels:
                bubbles    = self.template.bubbles_by_label[label]
                strip_means = strip_means_index[(block.name, label)]

                if is_int:
                    # Adaptive threshold: relative + absolute fallback catches
                    # lightly-filled digits that the gap algorithm misses.
                    readings = classify_strip_int(strip_means, bubbles, global_thr)
                else:
                    local_thr, is_tight_outlier = get_local_threshold(
                        strip_means, global_thr,
                        outlier_min_jump=MCQ_OUTLIER_MIN_JUMP,
                        return_meta=True,
                    )
                    # A tight-cluster threshold can sit inside a gap as small
                    # as 8px — smaller than the normal ±5px TOO_LIGHT band,
                    # which would otherwise catch both the marked bubble and
                    # its nearest blank neighbour as ambiguous. Use a hard
                    # split (confident_surplus=0) instead; see
                    # get_local_threshold()'s docstring for the full story.
                    readings = classify_strip(
                        strip_means, bubbles, local_thr,
                        confident_surplus=(0 if is_tight_outlier else CONFIDENT_SURPLUS),
                    )

                    # Center-fill guard (MCQ only): downgrade MARKED→TOO_LIGHT when
                    # the bubble's centre is still bright (printed ring, not real fill).
                    center_fills = strip_center_fills_index.get((block.name, label))
                    if center_fills:
                        readings = apply_center_fill_guard(readings, center_fills)

                result = read_field(label, block.field_type, readings)
                field_results[label] = result

        # ── Step 6b: Collect INT column warnings ─────────────────────────
        for label, result in field_results.items():
            for cw in result.column_warnings:
                digits_str = ",".join(cw.get("selected_digits", []))
                reason     = cw.get("reason", "multi_mark_info_field")
                details    = "; ".join(
                    f"{d['digit']}(mean={d['mean']},f={d['fill_ratio']})"
                    for d in cw.get("details", [])
                )
                warnings.append(
                    f"[INT] {label}: {digits_str} [{reason}] — {details}"
                )

        # ── Step 6c: Whole-photo quality gate ──────────────────────────────
        # 2026-08-04: an individual field landing on MULTI_MARK/NEEDS_REVIEW
        # occasionally is normal (a genuinely light pencil mark, a stray
        # smudge) — but a photo with uneven/poor lighting across the WHOLE
        # page makes MANY unrelated fields fail the same way at once, because
        # every field's classification threshold is ultimately trying to find
        # a light/dark separation that a page-wide contrast problem shrinks
        # everywhere simultaneously. Confirmed real cases (camera photos,
        # poor lighting): 38-45% of all digit/MCQ fields on the SAME photo
        # came back MULTI_MARK despite the physical sheet being correctly
        # filled (or even blank) — no per-field fix chases this down, because
        # the defect is in the raw pixel data, not any one field's logic (see
        # bubble_analyzer.py's classify_strip_int/classify_strip history).
        # A calibration pass across ~60 archived photos found a clear natural
        # gap: normal photos sit under ~18% (median ~2%), genuinely
        # bad-lighting photos jump to 45%+ — thresholds below sit safely in
        # that gap on both sides.
        multi_field_total = 0
        multi_field_bad = 0
        for label, result in field_results.items():
            bubbles = self.template.bubbles_by_label.get(label)
            if bubbles is None or len(bubbles) < 2:
                continue  # single-bubble fields (e.g. composite sign) have no local gap to judge
            multi_field_total += 1
            if result.status in (FieldStatus.MULTI_MARK, FieldStatus.NEEDS_REVIEW):
                multi_field_bad += 1

        if multi_field_total >= 10:  # enough fields to be a meaningful sample
            bad_ratio = multi_field_bad / multi_field_total
            if bad_ratio >= 0.35:
                warnings.append(
                    f"⚠️ Ảnh có độ tương phản kém — {multi_field_bad}/{multi_field_total} "
                    "câu/cột không đọc chắc chắn được cùng lúc. Rất có thể do ánh sáng/bóng đổ "
                    "không đều khi chụp, không phải lỗi từng câu riêng lẻ — nên chụp lại ảnh rõ "
                    "hơn, đủ sáng đều thay vì tin kết quả này."
                )
            elif bad_ratio >= 0.18:
                warnings.append(
                    f"Ảnh có khá nhiều câu/cột ({multi_field_bad}/{multi_field_total}) không "
                    "đọc chắc chắn được — nên kiểm tra lại ánh sáng lúc chụp nếu kết quả có vẻ sai."
                )

        # ── Step 7: Aggregate custom labels ───────────────────────────────
        custom_values: dict[str, tuple[str, FieldStatus]] = {}
        for custom_key, component_labels in self.template.custom_labels.items():
            val, status = aggregate_custom_label(custom_key, component_labels, field_results)
            custom_values[custom_key] = (val, status)

        # ── Step 7b: Aggregate composite signed-decimal answers ────────────
        # "Phần IV"-style fill-in-the-blank numeric questions (2026-07-28):
        # 3 raw sub-fields (sign / decimal-position / digit columns) were
        # already read like ordinary INT columns above — combine them here
        # into ONE answer (e.g. "-12.3") and insert it into field_results
        # under the composite key so it scores/serializes exactly like any
        # other answer field. The 3 raw sub-labels are excluded from scoring
        # below (composite_sub_labels) since they aren't independent
        # questions on their own.
        for comp_key, comp_spec in self.template.composite_answer_fields.items():
            sign_result = field_results.get(comp_spec.sign_label) if comp_spec.sign_label else None
            dec_result  = field_results.get(comp_spec.dec_label)  if comp_spec.dec_label  else None
            digit_results = [field_results.get(lbl) for lbl in comp_spec.digit_labels]
            value, status, comp_warnings = aggregate_signed_decimal(sign_result, dec_result, digit_results)
            field_results[comp_key] = FieldResult(
                field_label=comp_key,
                field_type="QTYPE_SIGNED_DECIMAL",
                selected_value=value,
                selected_values=[value] if value is not None else [],
                status=status,
            )
            for w in comp_warnings:
                warnings.append(
                    f"[SIGNED_DECIMAL] {comp_key} — {w['field']}: {w['type']} "
                    f"({','.join(w.get('candidates') or [])})"
                )

            # 2026-07-29: if aggregate_signed_decimal's sign-only guard fired
            # (a lone "-" mark with every digit/dec sub-field blank gets
            # downgraded to a blank composite answer — see that function's
            # comment), the RAW sign_result entry in field_results is left
            # untouched, so the "Ảnh detect" debug overlay — which draws
            # straight from field_results per raw sub-label, independently
            # of this composite step — kept showing a green "detected" box
            # on a bubble we'd just determined isn't a real mark. Confirmed
            # confusing on a real user photo: score was already correct, but
            # the overlay visibly disagreed with it. Purely cosmetic (score
            # already uses `status`/`value` above); overwrite the raw
            # sub-field too so the overlay matches the graded answer.
            if (
                status == FieldStatus.BLANK
                and sign_result is not None
                and sign_result.status == FieldStatus.ANSWERED
                and sign_result.selected_value == "-"
            ):
                field_results[comp_spec.sign_label] = FieldResult(
                    field_label=comp_spec.sign_label,
                    field_type=sign_result.field_type,
                    selected_value=None,
                    selected_values=[],
                    status=FieldStatus.BLANK,
                    fill_ratios=sign_result.fill_ratios,
                )

        # ── Step 8: Score ─────────────────────────────────────────────────
        grading_report = None
        if answer_key:
            skip = set(self.template.custom_labels.keys()) | self.template.composite_sub_labels
            # 2026-08-03: "để câu đúng xanh câu sai đỏ" (correctness-colored
            # "Ảnh detect" overlay) needs per-question correctness even for
            # multi-mã-đề exams, where the flat {label: letter} shape this
            # function expects isn't known until AFTER mã đề is detected —
            # which just happened above in Step 7 (`custom_values`). The
            # frontend (AnswerKeyPage.tsx handleGradeNow) sends a wrapper
            # `{"byMaDe": {"101": {...}, "102": {...}}, "default": {...}}`
            # instead of a flat dict for multi-mã-đề exams; resolve it here,
            # right before scoring. A plain flat dict (single-đề exams, and
            # any older/manual caller of this endpoint) passes through
            # unchanged — fully backward compatible.
            resolved_answer_key = answer_key
            if isinstance(answer_key, dict) and "byMaDe" in answer_key:
                by_ma_de = answer_key.get("byMaDe") or {}
                detected_ma_de: str | None = None
                val_status = custom_values.get("MaDe")
                if val_status is None:
                    # Custom templates may use a different custom_key for the
                    # mã đề block — fall back to matching by mapped name.
                    for key, vs in custom_values.items():
                        if key.lower() in ("made", "ma_de"):
                            val_status = vs
                            break
                if val_status is not None:
                    val, _st = val_status
                    detected_ma_de = val if val and val.strip("?") else None
                resolved_answer_key = (
                    (by_ma_de.get(detected_ma_de) if detected_ma_de else None)
                    or answer_key.get("default")
                    or {}
                )
            if resolved_answer_key:
                # section_labels=None → tự đoán theo tên field nếu khớp quy ước
                # đã biết (xem docstring _auto_detect_phan_sections); caller vẫn
                # có thể tự truyền section_labels để ghi đè nếu cần.
                effective_section_labels = (
                    section_labels if section_labels is not None
                    else self._auto_detect_phan_sections()
                )
                grading_report = score(
                    field_results=field_results,
                    answer_key=resolved_answer_key,
                    section_labels=effective_section_labels,
                    skip_labels=skip,
                    points_per_question=points_per_question,
                    question_points=question_points,
                    wrong_points=wrong_points,
                    blank_points=blank_points,
                )

        # Build bubble_means dict: {"label:value" → mean}
        bubble_means: dict[str, float] = {}
        for block in self.template.field_blocks:
            for label in block.field_labels:
                bubbles = self.template.bubbles_by_label[label]
                means = strip_means_index.get((block.name, label), [])
                for bubble, mean_val in zip(bubbles, means):
                    key = f"{bubble.field_label}:{bubble.bubble_value}"
                    bubble_means[key] = mean_val

        omr_result = OMRResult(
            field_results=field_results,
            custom_values=custom_values,
            grading_report=grading_report,
            prep_method=prep_method,
            global_threshold=global_thr,
            debug_overlay_path=None,
            warnings=warnings,
            marker_result=_marker_result,
            image_source=src,
            preprocess_strategy_used=preprocess_strategy_used,
            visual_aligned_mode=visual_aligned_mode,
            visual_aligned_size=visual_aligned_size,
            visual_aligned_aspect_ratio=visual_aligned_aspect_ratio,
            source_marker_aspect_ratio=source_marker_aspect_ratio,
            template_aspect_ratio=template_aspect_ratio,
            omr_read_space=omr_read_space,
            _M_inv=M_inv,
            signature_checks=signature_checks,
        )
        return omr_result, aligned_image, bubble_means, visual_image

    def generate_debug_overlay(
        self,
        image_input: Union[str, Path, np.ndarray],
        output_path: str | Path,
        field_results: dict[str, FieldResult] | None = None,
        show_mean_values: bool = True,
    ) -> Path:
        """
        Preprocess → resize → draw overlay → save.
        Always draws on the full pageDimensions image.
        Does NOT run OMR classification (unless field_results is provided).
        """
        raw = self._load_image(image_input)
        warnings: list[str] = []
        image, _, _ = self._preprocess(raw, warnings)
        if warnings:
            for w in warnings:
                logger.warning(w)

        image = resize_to_template(image, self.template.page_dimensions)

        if not _DEBUG_OVERLAY_AVAILABLE:
            logger.warning("Debug overlay disabled: debug_overlay module is not available")
            return None

        # Optionally compute mean values to show on overlay
        bubble_means: dict[str, float] | None = None
        if show_mean_values:
            bubble_means = {}
            for block in self.template.field_blocks:
                expand_px = block.roi_expand_px
                for label in block.field_labels:
                    for bubble in self.template.bubbles_by_label[label]:
                        roi = extract_roi_expanded(image, bubble, expand_px)
                        key = f"{bubble.field_label}:{bubble.bubble_value}"
                        bubble_means[key] = measure_roi(roi, mean_mode=self.mean_mode)

        block_expand_px = {
            block.name: block.roi_expand_px
            for block in self.template.field_blocks
            if block.roi_expand_px > 0
        }
        overlay = draw_template_overlay(
            image, self.template,
            field_results=field_results,
            bubble_means=bubble_means,
            block_expand_px=block_expand_px or None,
        )
        return save_overlay(overlay, output_path)

    # ── Private helpers ───────────────────────────────────────────────────

    def _build_means_json(
        self,
        field_results: dict[str, FieldResult],
        bubble_means: dict[str, float],
    ) -> list[dict]:
        """
        Build the full per-bubble detail list for means.json.

        Each entry:
          block, field, value, x, y, w, h, cx, cy, mean, marked, status
        """
        entries = []
        for block in self.template.field_blocks:
            for label in block.field_labels:
                bubbles = self.template.bubbles_by_label.get(label, [])
                result = field_results.get(label)
                for bubble in bubbles:
                    key = f"{bubble.field_label}:{bubble.bubble_value}"
                    mean_val = bubble_means.get(key)
                    marked = (
                        bubble.bubble_value in result.selected_values
                        if result else False
                    )
                    status_str = result.status.value if result else None
                    entries.append({
                        "block":   block.name,
                        "field":   bubble.field_label,
                        "value":   bubble.bubble_value,
                        "x":       bubble.x,
                        "y":       bubble.y,
                        "w":       bubble.w,
                        "h":       bubble.h,
                        "cx":      bubble.x + bubble.w // 2,
                        "cy":      bubble.y + bubble.h // 2,
                        "mean":    round(mean_val, 2) if mean_val is not None else None,
                        "marked":  marked,
                        "status":  status_str,
                    })
        return entries

    def _preprocess(
        self,
        image: np.ndarray,
        warnings: list[str],
        min_warp_quality: float = 0.45,
        image_source: str = "auto",
    ) -> tuple[np.ndarray, str, MarkerResult | None]:
        """
        Priority: CropOnMarkers (warp quality gate) → CropPage → no-crop.
        Returns (processed_image, prep_method_string, marker_result_or_None).

        prep_method values:
          "markers"          — 4 markers detected + warp quality gate passed
          "fallback_no_warp" — markers detected but warp rejected by quality gate
          "croppage"         — CropPage fallback (no reliable markers)
          "none"             — no crop (last resort)
        """
        if not self.enable_crop:
            logger.info("OMR: preprocessing disabled")
            return image, PrepMethod.NONE, None

        orig_h, orig_w = image.shape[:2]

        # ── Try CropOnMarkers first ───────────────────────────────────────
        target = (self.template.page_dimensions[0], self.template.page_dimensions[1])
        # Select destination marker centers:
        # 1. Check per-source override (markerCentersInTemplateBySource)
        # 2. Fall back to default markerCentersInTemplate
        marker_tpl_centers: dict | None = None
        source_label: str = "default"

        by_source = self.template.marker_centers_by_source or {}
        if image_source in by_source:
            marker_tpl_centers = {
                k: tuple(v) for k, v in by_source[image_source].items()
            }
            source_label = image_source
            logger.debug(
                f"OMR: using markerCentersInTemplateBySource[{image_source!r}] from template"
            )
        elif self.template.marker_centers_in_template:
            marker_tpl_centers = {
                k: tuple(v)
                for k, v in self.template.marker_centers_in_template.items()
            }
            logger.debug("OMR: using marker_centers_in_template from template (default)")

        marker_result = crop_on_markers(
            image,
            target_size=target,
            debug=True,
            marker_centers_in_template=marker_tpl_centers,
            min_warp_quality=min_warp_quality,
            # 2026-08-06: page W/H as a fallback expected-aspect for the
            # "legacy" templates (no marker_centers_in_template calibration,
            # e.g. shared_40tn_dungsai) — see page_aspect_fallback docstring
            # in crop_on_markers(). Only used when marker_tpl_centers is None
            # (crop_on_markers() itself prefers the precise calibrated value
            # whenever one is available).
            page_aspect_fallback=(target[0] / target[1] if target[1] else None),
        )

        # Populate per-source calibration debug fields on the result
        marker_result.marker_centers_source_used = source_label
        if marker_tpl_centers is not None:
            marker_result.destination_marker_centers_used = {
                k: list(v) for k, v in marker_tpl_centers.items()
            }
            # Estimate H-stretch: compare dst H/V span ratio vs src H/V span ratio
            if marker_result.marker_pts is not None and len(marker_result.marker_pts) == 4:
                src_pts = marker_result.marker_pts  # TL, TR, BR, BL
                dst = marker_tpl_centers
                src_h_span = float(np.linalg.norm(src_pts[1] - src_pts[0]))  # TR-TL
                src_v_span = float(np.linalg.norm(src_pts[3] - src_pts[0]))  # BL-TL
                dst_h_span = float(np.linalg.norm(
                    np.array(dst["TR"], dtype=float) - np.array(dst["TL"], dtype=float)
                ))
                dst_v_span = float(np.linalg.norm(
                    np.array(dst["BL"], dtype=float) - np.array(dst["TL"], dtype=float)
                ))
                if src_v_span > 0 and dst_v_span > 0:
                    h_scale = dst_h_span / src_h_span if src_h_span > 0 else 1.0
                    v_scale = dst_v_span / src_v_span
                    marker_result.estimated_h_stretch = round((h_scale / v_scale - 1.0) * 100, 2)

        if marker_result.success and marker_result.warp_used:
            # Quality gate passed — use warped image
            warp_mode  = "correct warp" if marker_tpl_centers else "legacy warp"
            stage_info = f"stage={marker_result.prep_stage}" if marker_result.prep_stage >= 0 else ""
            logger.info(
                f"OMR: CropOnMarkers [{warp_mode}] {stage_info} "
                f"q={marker_result.marker_quality_score:.2f} — "
                f"{orig_w}×{orig_h} → "
                f"{marker_result.target_size[0]}×{marker_result.target_size[1]}"
            )
            return marker_result.image, PrepMethod.MARKERS, marker_result

        # Markers detected but warp rejected by quality gate
        if marker_result.success and not marker_result.warp_used:
            warnings.append(
                f"Warp bị bỏ qua (quality={marker_result.marker_quality_score:.2f}, "
                f"reason={marker_result.warp_rejected_reason}) — thử CropPage"
            )
            logger.info(
                f"OMR: CropOnMarkers warp rejected "
                f"({marker_result.warp_rejected_reason}) — trying CropPage"
            )
        else:
            # No markers detected at all
            warnings.append(
                "Không detect đủ 4 marker góc để căn chỉnh phối cảnh "
                f"({marker_result.reason}) — thử CropPage"
            )
            logger.debug(f"CropOnMarkers failed: {marker_result.reason}")

        # ── Fallback: CropPage ────────────────────────────────────────────
        cp_result: CropPageResult = crop_page(image, morph_kernel=self._morph_kernel)
        if cp_result.success:
            logger.info(
                f"OMR: CropPage ✓ — {orig_w}×{orig_h} → "
                f"{cp_result.crop_size[0]}×{cp_result.crop_size[1]}"
            )
            # Keep marker_result for debug output (markers_debug_path, quality info)
            saved_mr = marker_result if marker_result.marker_pts is not None else None
            return cp_result.image, PrepMethod.CROPPAGE, saved_mr

        warnings.append(
            f"CropPage: {cp_result.reason} — sử dụng ảnh gốc ({orig_w}×{orig_h})"
        )
        logger.info("OMR: no crop — using original image")

        # If warp was rejected (markers found but quality low) record that
        if marker_result.success and not marker_result.warp_used:
            return image, PrepMethod.FALLBACK_NO_WARP, marker_result

        saved_mr = marker_result if marker_result.marker_pts is not None else None
        return image, PrepMethod.NONE, saved_mr

    def _save_overlay(
        self,
        image: np.ndarray,
        field_results: dict[str, FieldResult],
        filename: str | None,
    ) -> str | None:
        if not _DEBUG_OVERLAY_AVAILABLE:
            logger.warning("Debug overlay disabled: debug_overlay module is not available")
            return None

        try:
            overlay = draw_template_overlay(image, self.template, field_results=field_results)
            fname = filename or "debug_overlay.jpg"
            out_dir = self.debug_overlay_dir or Path("results/debug_overlays")
            saved = save_overlay(overlay, out_dir / fname)
            return str(saved)
        except Exception as e:
            logger.warning(f"Debug overlay failed: {e}")
            return None

    @staticmethod
    def _load_image(source: Union[str, Path, np.ndarray]) -> np.ndarray:
        if isinstance(source, np.ndarray):
            gray = cv2.cvtColor(source, cv2.COLOR_BGR2GRAY) if len(source.shape) == 3 else source
            return gray
        path = Path(source)
        if not path.exists():
            raise FileNotFoundError(f"Image not found: {path}")
        img = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
        if img is None:
            raise ValueError(f"Failed to decode image: {path}")
        return img


# ── VJUTemplate helper ────────────────────────────────────────────────────

def _template_blocks_in_order(self: VJUTemplate):
    yield from self.field_blocks

VJUTemplate.template_blocks_in_order = _template_blocks_in_order
