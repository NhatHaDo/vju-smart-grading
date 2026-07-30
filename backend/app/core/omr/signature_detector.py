"""
signature_detector.py
======================
Detects whether the "CÁN BỘ COI THI" (proctor) / "CÁN BỘ CHẤM THI" (grader)
signature boxes on an answer sheet have been signed (contain ink) or are
left blank.

Coordinates are in *template pixel space* — i.e. whatever `pageDimensions`
the loaded template declares, the same space fieldBlock origins use. Each
box set below was calibrated empirically the same way: ran the real OMR
alignment pipeline against an actual reference sheet for that exact
template, then located the signature-cell borders by detecting
horizontal/vertical rule lines, and located the printed
label-text/underline band inside each cell so it's excluded from the
"is this blank paper?" measurement (the printed label itself would
otherwise register as "ink" on every sheet, signed or not).

Registered box sets:
  "vju_main" — the fixed VJU presets (SBD4/SBD8). Calibrated against a real
               scanned sheet (2026-07-30). Both variants share identical
               pageDimensions + marker corners, i.e. identical page layout,
               so one box set covers both.
  "mau40"    — the pinned "Mẫu 40 câu TN + Đúng/Sai" custom template
               (backend/data/custom_forms/shared_40tn_dungsai.template.json).
               Only has 2 boxes (no separate "chấm thi" row on this sheet
               design) — calibrated against the reference sheet image
               (2026-07-30). Note: this template has `use_markers: false`
               (CropPage-only alignment, no 4-corner marker homography), so
               positioning is somewhat less robust to a skewed/rotated photo
               than "vju_main" — treat borderline "present: false" results
               here with a bit more caution on real-world (as opposed to
               flatbed-scanned) photos.

Any other custom (user-drawn) template has no registered box set and must
not call this — there's no guaranteed layout to measure.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# ── Calibrated box sets: box_set → key → (x0, x1, y0, y1) ───────────────────
# Already inset past the cell border lines and the printed label
# text/underline — each rectangle should read as blank white paper
# (mean ~255) on an unsigned sheet.
SIGNATURE_BOX_SETS: dict[str, dict[str, tuple[int, int, int, int]]] = {
    "vju_main": {
        "coi_thi_1":  (263, 557, 1442, 1558),
        "coi_thi_2":  (577, 869, 1442, 1558),
        "cham_thi_1": (263, 557, 1615, 1685),
        "cham_thi_2": (577, 869, 1615, 1685),
    },
    "mau40": {
        "coi_thi_1": (15, 233, 155, 240),
        "coi_thi_2": (15, 233, 295, 382),
    },
}

SIGNATURE_LABELS: dict[str, str] = {
    "coi_thi_1":  "Cán bộ coi thi 1",
    "coi_thi_2":  "Cán bộ coi thi 2",
    "cham_thi_1": "Cán bộ chấm thi 1",
    "cham_thi_2": "Cán bộ chấm thi 2",
}

# Blank paper reads ~253-255 on a clean scan/photo. A pen/marker signature —
# even a light, thin one — pulls the ROI mean down well past this. Kept
# generous on purpose: a missed "present" is worse than a false "missing"
# flag here, since this is a review aid, not an auto-reject gate.
BLANK_MEAN_THRESHOLD = 245.0


@dataclass
class SignatureCheck:
    key:       str
    label:     str
    present:   bool
    mean_gray: float


def detect_signatures(aligned_gray: np.ndarray, box_set: str = "vju_main") -> list[SignatureCheck]:
    """
    aligned_gray: single-channel grayscale image already resized/warped to
    the template's pageDimensions (i.e. `engine.py`'s `aligned_image` — the
    same array bubble/marker detection reads from).
    box_set: key into SIGNATURE_BOX_SETS — must match whichever template
    produced aligned_gray, or the coordinates will be meaningless.

    Returns one SignatureCheck per box, clipped to image bounds. Unknown
    box_set returns []. If the image is smaller than expected (shouldn't
    happen post resize_to_template, but defensive), a box entirely outside
    bounds is skipped rather than raising — callers should not treat an
    empty list as "all missing", only as "couldn't check".
    """
    boxes = SIGNATURE_BOX_SETS.get(box_set)
    if not boxes:
        return []
    h, w = aligned_gray.shape[:2]
    results: list[SignatureCheck] = []
    for key, (x0, x1, y0, y1) in boxes.items():
        xx0, xx1 = max(0, min(x0, w)), max(0, min(x1, w))
        yy0, yy1 = max(0, min(y0, h)), max(0, min(y1, h))
        if xx1 <= xx0 or yy1 <= yy0:
            continue
        roi = aligned_gray[yy0:yy1, xx0:xx1]
        mean_val = float(roi.mean())
        results.append(SignatureCheck(
            key=key,
            label=SIGNATURE_LABELS[key],
            present=mean_val < BLANK_MEAN_THRESHOLD,
            mean_gray=round(mean_val, 1),
        ))
    return results
