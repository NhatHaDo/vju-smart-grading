"""
preprocessor.py
===============
CropPage preprocessor: finds the outermost rectangular page boundary and warps
it to fill the frame.

Logic adapted from OMRChecker/src/processors/CropPage.py (read-only reference).

Key fix vs Phase 4:
- Added minimum area ratio guard (crop must be ≥ MIN_CROP_AREA_RATIO of original).
  This prevents CropPage from latching onto inner content (bubble blocks, tables).
- Added detailed logging (original size, crop bbox, crop size, resize size).
- Improved contour filtering: aspect ratio check + larger top-k candidates.
"""

from __future__ import annotations

import logging

import cv2
import numpy as np

logger = logging.getLogger(__name__)

# Crop result must cover at least this fraction of the original image area.
# If the detected rectangle is smaller than this, it's likely an inner element.
MIN_CROP_AREA_RATIO = 0.50

# Minimum fraction of original area for contour to even be considered.
MIN_CONTOUR_AREA_RATIO = 0.20

# Maximum cosine of inner angles (closer to 0 = more rectangular)
MAX_COSINE_FOR_RECT = 0.25


# ── Shared four-point perspective transform ───────────────────────────────

def order_points(pts: np.ndarray) -> np.ndarray:
    """Order 4 corner points: top-left, top-right, bottom-right, bottom-left."""
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    diff = np.diff(pts, axis=1)
    rect[0] = pts[np.argmin(s)]       # top-left (min x+y)
    rect[2] = pts[np.argmax(s)]       # bottom-right (max x+y)
    rect[1] = pts[np.argmin(diff)]    # top-right (min y-x)
    rect[3] = pts[np.argmax(diff)]    # bottom-left (max y-x)
    return rect


def four_point_transform(
    image: np.ndarray,
    pts: np.ndarray,
    target_size: tuple[int, int] | None = None,
) -> np.ndarray:
    """
    Warp image so that `pts` maps to a rectangle.

    Args:
        image:       Grayscale or BGR image.
        pts:         4 corner points (any order), shape (4, 2).
        target_size: If given, warp directly to (width, height).
                     Otherwise, compute from point distances.

    Returns:
        Perspective-corrected image.
    """
    rect = order_points(pts.astype("float32"))
    tl, tr, br, bl = rect

    if target_size is not None:
        max_width, max_height = target_size
    else:
        max_width  = max(int(np.linalg.norm(br - bl)), int(np.linalg.norm(tr - tl)))
        max_height = max(int(np.linalg.norm(tr - br)), int(np.linalg.norm(tl - bl)))

    dst = np.array(
        [[0, 0],
         [max_width - 1, 0],
         [max_width - 1, max_height - 1],
         [0, max_height - 1]],
        dtype="float32",
    )
    M = cv2.getPerspectiveTransform(rect, dst)
    return cv2.warpPerspective(image, M, (max_width, max_height))


# ── CropPage ─────────────────────────────────────────────────────────────

class CropPageResult:
    """Return value from crop_page(), carries diagnostics."""
    __slots__ = ("image", "success", "reason", "original_size", "crop_pts", "crop_size")

    def __init__(self, image, success, reason, original_size, crop_pts=None, crop_size=None):
        self.image         = image
        self.success       = success
        self.reason        = reason
        self.original_size = original_size   # (w, h)
        self.crop_pts      = crop_pts         # ndarray (4,2) or None
        self.crop_size     = crop_size        # (w, h) of cropped result or None


def crop_page(
    image: np.ndarray,
    morph_kernel: tuple[int, int] = (10, 10),
    min_area_ratio: float = MIN_CROP_AREA_RATIO,
) -> CropPageResult:
    """
    Detect the sheet outer boundary and warp it.

    Returns a CropPageResult with .success and .image (cropped or original).
    Caller should check .success and use .image accordingly.
    """
    gray = image if len(image.shape) == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    orig_h, orig_w = gray.shape[:2]
    orig_area = orig_h * orig_w
    original_size = (orig_w, orig_h)

    logger.debug(f"CropPage: original size = {orig_w}×{orig_h}")

    # ── Edge detection ────────────────────────────────────────────────────
    norm = cv2.normalize(gray, None, 0, 255, cv2.NORM_MINMAX)
    blurred = cv2.GaussianBlur(norm, (5, 5), 0)
    blurred = cv2.normalize(blurred, None, 0, 255, cv2.NORM_MINMAX)

    _, threshed = cv2.threshold(blurred, 200, 200, cv2.THRESH_TRUNC)
    threshed = cv2.normalize(threshed, None, 0, 255, cv2.NORM_MINMAX)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, morph_kernel)
    closed = cv2.morphologyEx(threshed, cv2.MORPH_CLOSE, kernel)
    edge = cv2.Canny(closed, 50, 150)

    # ── Find candidate contours ───────────────────────────────────────────
    cnts, _ = cv2.findContours(edge, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    cnts = [cv2.convexHull(c) for c in cnts]
    cnts = sorted(cnts, key=cv2.contourArea, reverse=True)[:10]

    min_contour_area = MIN_CONTOUR_AREA_RATIO * orig_area

    for c in cnts:
        cnt_area = cv2.contourArea(c)
        if cnt_area < min_contour_area:
            break  # sorted descending, no need to look further

        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        if len(approx) != 4:
            continue

        pts = approx.reshape(4, 2).astype("float32")
        if not _is_rectangle(pts, max_cosine=MAX_COSINE_FOR_RECT):
            continue

        # ── Area guard: reject if crop is too small relative to original ─
        crop_area = cnt_area
        area_ratio = crop_area / orig_area
        if area_ratio < min_area_ratio:
            logger.debug(
                f"CropPage: rejected contour — area ratio {area_ratio:.2f} < "
                f"minimum {min_area_ratio:.2f}"
            )
            continue

        # Aspect ratio guard: answer sheet should be roughly A4 (0.5 < w/h < 2)
        ordered = order_points(pts)
        tl, tr, br, bl = ordered
        w_est = max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl))
        h_est = max(np.linalg.norm(br - tr), np.linalg.norm(bl - tl))
        if h_est > 0 and not (0.4 < w_est / h_est < 2.5):
            logger.debug(
                f"CropPage: rejected — aspect ratio {w_est/h_est:.2f} out of range"
            )
            continue

        # ── Warp ─────────────────────────────────────────────────────────
        cropped = four_point_transform(gray, pts)
        crop_h, crop_w = cropped.shape[:2]
        logger.debug(
            f"CropPage: ✓ crop bbox = {pts.tolist()}, "
            f"crop size = {crop_w}×{crop_h}, ratio = {area_ratio:.2f}"
        )
        return CropPageResult(
            image=cropped,
            success=True,
            reason="ok",
            original_size=original_size,
            crop_pts=pts,
            crop_size=(crop_w, crop_h),
        )

    logger.debug("CropPage: page boundary not found — using original image")
    return CropPageResult(
        image=gray,
        success=False,
        reason="not_detected",
        original_size=original_size,
    )


def _angle(p1: np.ndarray, p2: np.ndarray, p0: np.ndarray) -> float:
    d1 = p1.astype(float) - p0
    d2 = p2.astype(float) - p0
    denom = np.sqrt((d1 @ d1) * (d2 @ d2)) + 1e-10
    return float(np.dot(d1, d2) / denom)


def _is_rectangle(pts: np.ndarray, max_cosine: float = MAX_COSINE_FOR_RECT) -> bool:
    for i in range(2, 6):
        cos = abs(_angle(pts[i % 4], pts[(i - 2) % 4], pts[(i - 1) % 4]))
        if cos > max_cosine:
            return False
    return True


# ── Resize to template resolution ────────────────────────────────────────

def resize_to_template(
    image: np.ndarray,
    page_dimensions: list[int],
) -> np.ndarray:
    """
    Resize (STRETCH) image to exactly pageDimensions [width, height].
    Aspect ratio is NOT preserved — may distort if scan AR differs from template.
    Uses INTER_AREA for downscaling, INTER_CUBIC for upscaling.
    """
    target_w, target_h = page_dimensions
    h, w = image.shape[:2]

    if w == target_w and h == target_h:
        return image

    scale_x = target_w / w
    scale_y = target_h / h
    ar_orig = w / h
    ar_tmpl = target_w / target_h
    if abs(ar_orig - ar_tmpl) > 0.02:
        logger.warning(
            f"resize_to_template (STRETCH): AR mismatch — "
            f"orig={w}x{h} AR={ar_orig:.4f}  tmpl={target_w}x{target_h} AR={ar_tmpl:.4f}  "
            f"scale_x={scale_x:.4f}  scale_y={scale_y:.4f}  diff={ar_orig-ar_tmpl:+.4f}"
        )
    else:
        logger.debug(
            f"resize_to_template: {w}x{h} -> {target_w}x{target_h}  "
            f"scale_x={scale_x:.4f} scale_y={scale_y:.4f}"
        )

    interp = cv2.INTER_AREA if (w > target_w or h > target_h) else cv2.INTER_CUBIC
    return cv2.resize(image, (target_w, target_h), interpolation=interp)


def resize_fit_pad(
    image: np.ndarray,
    page_dimensions: list[int],
    pad_value: int = 255,
) -> tuple[np.ndarray, float, int, int]:
    """
    Resize image to fit within pageDimensions while PRESERVING aspect ratio,
    centre it, and pad the remaining area with pad_value (255 = white).

    Returns:
        padded  — image at exactly (target_w x target_h)
        scale   — uniform scale factor applied to the original
        off_x   — x pixels from left where content starts
        off_y   — y pixels from top where content starts

    Alignment note:
        Template bubble coords are in the full 2550x3301 space.
        After fit-pad, actual scan content sits at canvas[off_y:off_y+new_h, off_x:off_x+new_w].
        To project a template point (tx, ty) into the padded image:
            px = off_x + tx * scale
            py = off_y + ty * scale
    """
    target_w, target_h = page_dimensions
    h, w = image.shape[:2]

    scale = min(target_w / w, target_h / h)
    new_w = int(round(w * scale))
    new_h = int(round(h * scale))

    interp = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_CUBIC
    resized = cv2.resize(image, (new_w, new_h), interpolation=interp)

    canvas = np.full((target_h, target_w), pad_value, dtype=np.uint8)
    off_x = (target_w - new_w) // 2
    off_y = (target_h - new_h) // 2
    canvas[off_y:off_y + new_h, off_x:off_x + new_w] = resized

    ar_orig = w / h
    ar_tmpl = target_w / target_h
    logger.info(
        f"resize_fit_pad: {w}x{h} AR={ar_orig:.4f} -> "
        f"content {new_w}x{new_h} scale={scale:.4f} "
        f"pad->{target_w}x{target_h} offset=({off_x},{off_y}) "
        f"tmpl_AR={ar_tmpl:.4f} AR_diff={ar_orig-ar_tmpl:+.4f}"
    )
    return canvas, scale, off_x, off_y
