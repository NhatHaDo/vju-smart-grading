"""crop_on_markers: the 4 corner markers chosen together (2026-10-06).

"4 góc phải tạo thành hình chữ nhật hoặc vuông chứ đúng ko ? … sửa sao cho
tối ưu" — a drawn sheet like the Bộ GD one (corner squares + many small
squares along its edges) photographed the hard ways: on a dark desk, held at
an angle, with dark objects next to it, far from the middle of the frame,
under a hand's shadow. The 4 corners found must be the corner squares."""
import cv2
import numpy as np
import pytest

from app.core.omr.crop_on_markers import crop_on_markers

PW, PH = 700, 990           # sheet (≈ A4)
M, S = 40, 22               # corner marker inset and side


def _sheet() -> tuple[np.ndarray, np.ndarray]:
    """White sheet, 4 corner squares, inner section squares and print."""
    page = np.full((PH, PW), 245, np.uint8)
    corners = np.float32([[M + S / 2, M + S / 2], [PW - M - S / 2, M + S / 2],
                          [PW - M - S / 2, PH - M - S / 2], [M + S / 2, PH - M - S / 2]])
    for x, y in corners:
        cv2.rectangle(page, (int(x - S / 2), int(y - S / 2)), (int(x + S / 2), int(y + S / 2)), 10, -1)
    # inner squares (section dividers / timing marks), the same kind as the corners
    for y in (180, 400, 620, 840):
        for x in (75, 250, 450, PW - 75):
            cv2.rectangle(page, (x - 9, y - 9), (x + 9, y + 9), 10, -1)
    # some print: boxes, bubbles, text lines
    for r in range(8):
        for c in range(4):
            cv2.circle(page, (140 + c * 30 + (r % 2) * 160, 230 + r * 20), 7, 60, 1)
    for y in range(90, 160, 14):
        cv2.line(page, (120, y), (560, y), 90, 2)
    cv2.rectangle(page, (100, 470), (600, 780), 80, 2)
    return page, corners


def _photo(bg: int, scale: float, cx: float, cy: float, keystone: float = 0.0, rot: float = 0.0,
           decoys: bool = False, shadow: bool = False) -> tuple[np.ndarray, np.ndarray]:
    page, corners = _sheet()
    W, H = 900, 1200
    src = np.float32([[0, 0], [PW, 0], [PW, PH], [0, PH]])
    sw, sh = PW * scale, PH * scale
    d = np.float32([[-sw / 2, -sh / 2], [sw / 2, -sh / 2], [sw / 2, sh / 2], [-sw / 2, sh / 2]])
    d[0, 0] += keystone * sw
    d[1, 0] -= keystone * sw
    c, s = np.cos(np.radians(rot)), np.sin(np.radians(rot))
    d = d @ np.float32([[c, s], [-s, c]]) + np.float32([cx * W, cy * H])
    Mx = cv2.getPerspectiveTransform(src, d.astype(np.float32))
    img = np.full((H, W), bg, np.uint8)
    warped = cv2.warpPerspective(page, Mx, (W, H))
    mask = cv2.warpPerspective(np.full(page.shape, 255, np.uint8), Mx, (W, H))
    img[mask > 0] = warped[mask > 0]
    if decoys:      # dark marker-sized things lying on the desk near the frame's corners
        for x, y in ((25, 20), (W - 50, H - 45)):
            cv2.rectangle(img, (x, y), (x + int(S * scale), y + int(S * scale)), 15, -1)
    if shadow:
        yy, xx = np.mgrid[0:H, 0:W]
        dark = ((xx - W * 0.15) ** 2 / (W * 0.35) ** 2 + (yy - H * 0.9) ** 2 / (H * 0.25) ** 2) < 1
        img = np.where(dark, (img * 0.5).astype(np.uint8), img)
    img = cv2.GaussianBlur(img, (0, 0), 0.8)
    gt = cv2.perspectiveTransform(corners.reshape(-1, 1, 2), Mx).reshape(-1, 2)
    return img, gt


CASES = {
    "flat":       dict(bg=170, scale=1.0, cx=0.5, cy=0.5),
    "dark_desk":  dict(bg=50, scale=0.95, cx=0.5, cy=0.5),
    "keystone":   dict(bg=170, scale=1.05, cx=0.5, cy=0.5, keystone=0.12, rot=4),
    "decoys":     dict(bg=175, scale=0.95, cx=0.5, cy=0.5, rot=-3, decoys=True),
    "off_centre": dict(bg=170, scale=0.65, cx=0.36, cy=0.38),
    "shadow":     dict(bg=170, scale=1.0, cx=0.5, cy=0.5, rot=2, shadow=True),
}


@pytest.mark.parametrize("name", list(CASES))
@pytest.mark.parametrize("small", [False, True], ids=["full", "quick480"])
def test_corner_markers_found(name, small):
    img, gt = _photo(**CASES[name])
    if small:       # Chấm nhanh's camera check runs on a 480 px wide frame
        f = 480 / img.shape[1]
        img = cv2.resize(img, (480, int(img.shape[0] * f)), interpolation=cv2.INTER_AREA)
        gt = gt * f
    r = crop_on_markers(img, target_size=None if small else (1000, 1414),
                        min_warp_quality=0.55 if small else 0.45)
    assert r.success and r.marker_pts is not None, name
    err = np.linalg.norm(np.asarray(r.marker_pts, dtype=float) - gt, axis=1).max()
    assert err < 0.015 * img.shape[1], f"{name}: corner off by {err:.1f}px"


def test_corner_hidden_keeps_the_visible_corners():
    """One corner covered (a thumb): the 3 corners that can be seen are still
    the real ones — a row of inner squares is not taken for the bottom edge
    while a real corner square sits just outside it. (The hidden corner itself
    can't be known; the photo has to be taken again.)"""
    img, gt = _photo(**CASES["flat"])
    x, y = gt[3].astype(int)
    cv2.rectangle(img, (x - 30, y - 30), (x + 30, y + 30), 245, -1)
    r = crop_on_markers(img, target_size=(1000, 1414), min_warp_quality=0.45)
    if r.success and r.marker_pts is not None:
        err = np.linalg.norm(np.asarray(r.marker_pts, dtype=float)[:3] - gt[:3], axis=1).max()
        assert err < 0.015 * img.shape[1]
