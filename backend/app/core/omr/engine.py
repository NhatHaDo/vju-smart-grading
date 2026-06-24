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
from dataclasses import dataclass, field
from pathlib import Path
from typing import Union

import cv2
import numpy as np

from app.core.omr.bubble_analyzer import (
    GLOBAL_DEFAULT_THR,
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
from app.core.omr.debug_overlay import (
    draw_overlay_marked_only,
    draw_overlay_projected,
    draw_overlay_warnings,
    draw_template_overlay,
    save_overlay,
)
from app.core.omr.field_reader import (
    FieldResult,
    FieldStatus,
    aggregate_custom_label,
    read_field,
)
from app.core.omr.preprocessor import CropPageResult, crop_page, resize_fit_pad, resize_to_template
from app.core.omr.roi_extractor import extract_roi, extract_roi_expanded, extract_roi_inverse
from app.core.omr.scorer import GradingReport, score
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
    ):
        """
        Args:
            template:          Parsed VJUTemplate.
            enable_crop:       If False, skip all preprocessing (useful for debug).
            debug_overlay_dir: Auto-save overlay here after every run() call.
            mean_mode:         "circle_mask" (default) or "rect".
                               circle_mask avoids grid lines and digit borders.
        """
        self.template = template
        self.enable_crop = enable_crop
        self.debug_overlay_dir = Path(debug_overlay_dir) if debug_overlay_dir else None
        self.mean_mode = mean_mode
        self._morph_kernel: tuple[int, int] = (10, 10)
        self._target_size = tuple(template.page_dimensions)  # (w, h)

    # ── Public API ────────────────────────────────────────────────────────

    def run(
        self,
        image_input: Union[str, Path, np.ndarray],
        answer_key: dict[str, str] | None = None,
        section_labels: dict[str, list[str]] | None = None,
        debug_filename: str | None = None,
        image_source: str = "auto",
    ) -> OMRResult:
        """Full OMR pipeline. Returns OMRResult."""
        omr_result, _aligned, _means, _visual = self._execute(
            image_input,
            answer_key=answer_key,
            section_labels=section_labels,
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
        answer_key: dict[str, str] | None = None,
        section_labels: dict[str, list[str]] | None = None,
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
            section_labels:Optional section groupings for scoring.
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
            image_source=image_source,
        )

        vis = DebugVisualPaths()

        if aligned_image is None:
            logger.error("run_full_debug: aligned_image is None — cannot save debug outputs")
            return omr_result, vis

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
                )
            else:
                img_all = draw_template_overlay(
                    aligned_image, self.template,
                    field_results=omr_result.field_results,
                    bubble_means=bubble_means,
                    draw_mode="both",
                    block_expand_px=block_expand_px or None,
                )
            p = save_overlay(img_all, out / f"{prefix}_overlay_all.jpg")
            vis.overlay_all_path = str(p)
            logger.info(f"Saved overlay_all → {p} (projected={_use_projected})")
        except Exception as e:
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

        # Also set the main overlay_path on the result for backward compat
        omr_result.debug_overlay_path = vis.overlay_all_path
        return omr_result, vis

    # ── Internal pipeline ─────────────────────────────────────────────────

    # Minimum estimated H-stretch (%) that triggers Phase 1 visual fix
    _VISUAL_FIX_H_STRETCH_THRESHOLD = 8.0

    def _execute(
        self,
        image_input: Union[str, Path, np.ndarray],
        answer_key: dict[str, str] | None = None,
        section_labels: dict[str, list[str]] | None = None,
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

        # ── Phase 1 visual fix ────────────────────────────────────────────
        # For scan_app with significant H-stretch: produce a flat, AR-preserving
        # display image by warping to the natural marker-measured rectangle.
        # The OMR read path (Phase 2) remains unaffected — it reads via M_inv
        # from the original image regardless of which visual image is shown.
        visual_image: np.ndarray | None = None
        visual_aligned_mode = "warp"
        visual_aligned_size: tuple[int, int] | None = None
        visual_aligned_aspect_ratio: float | None = None
        source_marker_aspect_ratio: float | None = None

        # Compute template AR once (pageDimensions)
        tpl_w, tpl_h = self.template.page_dimensions
        template_aspect_ratio = round(tpl_w / tpl_h, 4) if tpl_h > 0 else None

        mr_for_stretch = _marker_result
        if (
            src == "scan_app"
            and mr_for_stretch is not None
            and mr_for_stretch.estimated_h_stretch is not None
            and mr_for_stretch.estimated_h_stretch > self._VISUAL_FIX_H_STRETCH_THRESHOLD
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
                    f"OMR Phase1: scan_app h_stretch={mr_for_stretch.estimated_h_stretch:.1f}% "
                    f"→ rectified_keep_aspect {rect_w}×{rect_h} "
                    f"(marker_ar={source_marker_aspect_ratio}, tpl_ar={template_aspect_ratio})"
                )
            except Exception as exc:
                logger.warning(f"OMR Phase1: create_visual_rectified_keep_aspect failed — {exc}")

        # ── Phase 2 inverse-H read: compute M_inv when conditions are met ───
        # Condition: scan_app + warp applied + h_stretch > threshold + homography exists
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
                    f"OMR Phase2: h_stretch={_marker_result.estimated_h_stretch:.1f}% "
                    f"→ reading bubbles via M_inv from original image"
                )
            except np.linalg.LinAlgError as exc:
                logger.warning(f"OMR Phase2: M_inv compute failed ({exc}) — fallback to warp read")

        # Select the read image: original (raw) for inverse-H, warped for standard
        read_image = raw if M_inv is not None else image

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
                    local_thr = get_local_threshold(strip_means, global_thr)
                    readings  = classify_strip(strip_means, bubbles, local_thr)

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

        # ── Step 7: Aggregate custom labels ───────────────────────────────
        custom_values: dict[str, tuple[str, FieldStatus]] = {}
        for custom_key, component_labels in self.template.custom_labels.items():
            val, status = aggregate_custom_label(custom_key, component_labels, field_results)
            custom_values[custom_key] = (val, status)

        # ── Step 8: Score ─────────────────────────────────────────────────
        grading_report = None
        if answer_key:
            skip = set(self.template.custom_labels.keys())
            grading_report = score(
                field_results=field_results,
                answer_key=answer_key,
                section_labels=section_labels,
                skip_labels=skip,
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
