"""
block_snap.py
=============
Per-block position refinement after the 4-corner warp (2026-10-05).

"tạo và chấm cho a thử bộ phiếu này": on phone photos of a curled page the
4-corner homography lands the outer markers exactly but a block near a bent
edge can still sit half a bubble off (seen on the "Phiếu BGD" photos: the
Câu 1-10 block shifted ~10 px, so every answer in it was misread).

For every field block: find the printed bubbles around it (Hough circles)
and try every shift up to SEARCH_PX that lands a template bubble on a printed
one; the shift that lands the most bubbles wins (sliding a whole row or
column loses the block's edge row, so it never wins), and the block moves by
the median offset of the bubbles it landed.
A block whose bubbles already sit on the printed ones stays exactly where it
is, so a well-aligned sheet reads as before.
"""

from __future__ import annotations

import logging
from dataclasses import replace

import cv2
import numpy as np

from app.core.templates.template_loader import VJUTemplate

logger = logging.getLogger(__name__)

SEARCH_PX = 16        # never move a block further than this (page px)
TOL_PX = 5            # a bubble sits on a printed circle when their centres are this close
MIN_SHIFT = 2         # smaller offsets are noise, leave the block alone
MIN_MATCHED = 0.4     # share of the block's bubbles that must find a printed circle


def _min_step(along: np.ndarray, across: np.ndarray) -> float:
    """Smallest gap between neighbouring bubbles on the same line (same `across`)."""
    best = float("inf")
    key = np.rint(across / 4)
    for a in np.unique(key):
        d = np.diff(np.sort(along[key == a]))
        d = d[d > 2]
        if len(d):
            best = min(best, float(d.min()))
    return best if best != float("inf") else 2 * SEARCH_PX + 2


def _circles(gray: np.ndarray, x0: int, y0: int, x1: int, y1: int,
             r_min: int, r_max: int, min_dist: float) -> np.ndarray:
    roi = gray[y0:y1, x0:x1]
    if roi.size == 0:
        return np.empty((0, 2), np.float32)
    c = cv2.HoughCircles(cv2.medianBlur(roi, 3), cv2.HOUGH_GRADIENT, dp=1, minDist=max(4.0, min_dist),
                         param1=100, param2=14, minRadius=r_min, maxRadius=r_max)
    if c is None:
        return np.empty((0, 2), np.float32)
    c = c[0][:, :2].astype(np.float32)
    c[:, 0] += x0
    c[:, 1] += y0
    return c


def block_offsets(image: np.ndarray, template: VJUTemplate) -> dict[str, tuple[int, int]]:
    """{block name: (dx, dy)} for the blocks worth moving; the others are left out."""
    gray = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape[:2]
    out: dict[str, tuple[int, int]] = {}
    for block in template.field_blocks:
        bubbles = [b for lbl in block.field_labels for b in template.bubbles_by_label.get(lbl, [])]
        if len(bubbles) < 4:
            continue
        cx = np.array([b.x + b.w / 2 for b in bubbles], dtype=np.float32)
        cy = np.array([b.y + b.h / 2 for b in bubbles], dtype=np.float32)
        step = min(_min_step(cx, cy), _min_step(cy, cx))
        lim = SEARCH_PX
        size = min(min(b.w, b.h) for b in bubbles)
        r_min, r_max = max(4, int(size * 0.25)), max(6, int(size * 0.6) + 2)
        pad = int(lim + r_max + 4)
        found = _circles(gray, max(0, int(cx.min()) - pad), max(0, int(cy.min()) - pad),
                         min(w, int(cx.max()) + pad), min(h, int(cy.max()) + pad),
                         r_min, r_max, 0.6 * step)
        if len(found) == 0:
            continue
        tpl = np.stack([cx, cy], axis=1)
        # every (printed circle − template bubble) vector within reach is a
        # candidate shift; keep the one that puts the most bubbles on a
        # printed circle. Sliding a whole row/column loses the edge row of the
        # block, so the true shift wins even when it is half a pitch.
        d = found[None, :, :] - tpl[:, None, :]                              # (bubbles, circles, 2)
        cand = d.reshape(-1, 2)
        cand = cand[np.hypot(cand[:, 0], cand[:, 1]) <= lim]
        if len(cand) == 0:
            continue
        cand = np.unique(np.rint(cand), axis=0)

        def matched(shift: np.ndarray) -> np.ndarray:
            r = np.hypot(d[..., 0] - shift[0], d[..., 1] - shift[1]).min(axis=1)
            return r <= TOL_PX

        counts = np.array([matched(c).sum() for c in cand])
        zero = int(matched(np.zeros(2)).sum())
        top = counts.max()
        if top < max(4, MIN_MATCHED * len(bubbles)) or top <= zero:
            continue
        best = cand[counts == top]
        shift = best[np.hypot(best[:, 0], best[:, 1]).argmin()]
        ok = matched(shift)
        offs = d[np.arange(len(bubbles)), np.hypot(d[..., 0] - shift[0], d[..., 1] - shift[1]).argmin(axis=1)][ok]
        med = np.median(offs, axis=0)
        dx, dy = int(round(float(med[0]))), int(round(float(med[1])))
        if max(abs(dx), abs(dy)) >= MIN_SHIFT:
            out[block.name] = (dx, dy)
    return out


def shifted_template(template: VJUTemplate, offsets: dict[str, tuple[int, int]]) -> VJUTemplate:
    """A copy of the template with the bubbles of each moved block shifted; the original is untouched."""
    if not offsets:
        return template
    moved: dict[int, object] = {}   # id(original bubble) → shifted copy, shared by block.bubbles and bubbles_by_label

    def mv(b):
        if b.block_name not in offsets:
            return b
        if id(b) not in moved:
            dx, dy = offsets[b.block_name]
            moved[id(b)] = replace(b, x=b.x + dx, y=b.y + dy)
        return moved[id(b)]

    blocks = [
        replace(blk, bubbles=[mv(b) for b in blk.bubbles],
                origin=[blk.origin[0] + offsets[blk.name][0], blk.origin[1] + offsets[blk.name][1]])
        if blk.name in offsets else blk
        for blk in template.field_blocks
    ]
    by_label = {label: [mv(b) for b in bubbles] for label, bubbles in template.bubbles_by_label.items()}
    return replace(template, field_blocks=blocks, bubbles_by_label=by_label)


def snap_template(image: np.ndarray, template: VJUTemplate) -> tuple[VJUTemplate, dict[str, tuple[int, int]]]:
    try:
        offsets = block_offsets(image, template)
    except Exception as exc:   # never let refinement break a read
        logger.warning(f"OMR block snap skipped: {exc}")
        return template, {}
    if offsets:
        logger.info(f"OMR block snap: {offsets}")
    return shifted_template(template, offsets), offsets
