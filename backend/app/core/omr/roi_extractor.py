"""
roi_extractor.py
================
Extract bubble ROI patches from a preprocessed grayscale image.

ROI formula (verified from OMRChecker core.py):
    img[y : y + h,  x : x + w]   (top-left convention)
"""

from __future__ import annotations

import cv2
import numpy as np

from app.core.templates.template_loader import BubbleSpec


def extract_roi(image: np.ndarray, bubble: BubbleSpec) -> np.ndarray:
    """
    Crop the ROI for a single bubble.

    Args:
        image:  Grayscale image at pageDimensions resolution.
        bubble: BubbleSpec with top-left (x, y) and dimensions (w, h).

    Returns:
        Grayscale numpy array of shape (h, w).
    """
    x, y, w, h = bubble.x, bubble.y, bubble.w, bubble.h
    img_h, img_w = image.shape[:2]

    # Safety clamp (should never trigger if template is valid)
    x1 = max(0, x)
    y1 = max(0, y)
    x2 = min(img_w, x + w)
    y2 = min(img_h, y + h)

    roi = image[y1:y2, x1:x2]
    return roi


def extract_roi_expanded(
    image: np.ndarray,
    bubble: BubbleSpec,
    expand_px: int = 0,
) -> np.ndarray:
    """
    Crop an expanded ROI for a single bubble, keeping the bubble center fixed.

    Grows the read area by `expand_px` on each side (total +2*expand_px in each
    dimension) while never crossing image boundaries.  Use a small value (2–4 px)
    to catch marks that bleed slightly outside the nominal bubble rectangle.

    Safe upper bound to avoid reading neighbour bubbles:
        expand_px  <=  (bubblesGap - bubbleDim) // 2 - 1

    For the default 32×32 / 43-gap blocks this works out to ≤ 4 px.
    For the 40×40 / 105-gap MCQ blocks it allows up to ≤ 32 px (more than enough).

    Args:
        image:     Grayscale image at pageDimensions resolution.
        bubble:    BubbleSpec with top-left (x, y) and dimensions (w, h).
        expand_px: Pixels to add on each side (0 = identical to extract_roi).

    Returns:
        Grayscale numpy array, possibly larger than (h, w).
    """
    if expand_px <= 0:
        return extract_roi(image, bubble)

    x, y, w, h = bubble.x, bubble.y, bubble.w, bubble.h
    img_h, img_w = image.shape[:2]

    x1 = max(0, x - expand_px)
    y1 = max(0, y - expand_px)
    x2 = min(img_w, x + w + expand_px)
    y2 = min(img_h, y + h + expand_px)

    return image[y1:y2, x1:x2]


def extract_roi_inverse(
    image: np.ndarray,
    bubble: BubbleSpec,
    M_inv: np.ndarray,
    expand_px: int = 0,
) -> np.ndarray:
    """
    Extract a bubble ROI from *original* image space using the inverse homography.

    Instead of indexing into a warped/stretched image at template (x,y), this
    maps the bubble's template-space bounding box back to original image coordinates
    via M_inv, then warps that small quadrilateral to the canonical (w,h) output
    expected by bubble_analyzer.

    Args:
        image:    Grayscale original image (NOT warped to pageDimensions).
        bubble:   BubbleSpec with template-space (x, y, w, h).
        M_inv:    3×3 inverse homography: template space → original image space.
        expand_px: Grow the bubble rectangle on each side before projection.
                   (mirrors the expand_px semantics of extract_roi_expanded)

    Returns:
        Grayscale array of shape (h+2*expand_px, w+2*expand_px).
        Falls back to a white (255) array of the same size on projection failure.
    """
    x, y, w, h = bubble.x, bubble.y, bubble.w, bubble.h
    out_w = w + 2 * expand_px
    out_h = h + 2 * expand_px

    # Build the 4-corner rectangle in template space (with expansion)
    x0 = x - expand_px
    y0 = y - expand_px
    x1 = x + w + expand_px
    y1 = y + h + expand_px

    template_corners = np.array(
        [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], dtype="float32"
    ).reshape(1, 4, 2)

    # Project to original image space
    try:
        scan_corners = cv2.perspectiveTransform(template_corners, M_inv).reshape(4, 2)
    except Exception:
        return np.full((out_h, out_w), 255, dtype=np.uint8)

    # Clip corners to image bounds
    img_h, img_w = image.shape[:2]
    scan_corners[:, 0] = np.clip(scan_corners[:, 0], 0, img_w - 1)
    scan_corners[:, 1] = np.clip(scan_corners[:, 1], 0, img_h - 1)

    # Destination: canonical (out_w × out_h) rectangle
    dst_corners = np.array(
        [[0, 0], [out_w - 1, 0], [out_w - 1, out_h - 1], [0, out_h - 1]],
        dtype="float32",
    )

    try:
        M_local = cv2.getPerspectiveTransform(scan_corners, dst_corners)
        roi = cv2.warpPerspective(
            image, M_local, (out_w, out_h),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REPLICATE,
        )
    except Exception:
        return np.full((out_h, out_w), 255, dtype=np.uint8)

    return roi


def extract_all_rois(
    image: np.ndarray,
    bubbles: list[BubbleSpec],
    expand_px: int = 0,
) -> list[np.ndarray]:
    """Extract ROI for each bubble in a list (preserves order).

    Args:
        expand_px: Passed to extract_roi_expanded; 0 uses nominal bubble box.
    """
    if expand_px > 0:
        return [extract_roi_expanded(image, b, expand_px) for b in bubbles]
    return [extract_roi(image, b) for b in bubbles]
