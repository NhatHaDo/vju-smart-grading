"""
Mã QR đáp án of a kỳ thi (like the QR of the QM app, but tiny).

The QR holds only a signed reference — "VJUAK1:<exam id>.<sig>" for a kỳ
thi, "VJUAK2:<share id>.<sig>" for đáp án uploaded from Excel — not the
answers themselves: a QR carrying every mã đề's answers is too
dense to read reliably from a phone photo (and OpenCV's encoder breaks above
version 6). Scanning it in Chấm nhanh fetches the kỳ thi's current answer key
from the server, so the same printed QR stays right after đáp án are edited.
The signature (HMAC with the server secret) stops anyone from reading another
kỳ thi's answers by guessing ids.
"""
import base64
import hashlib
import hmac
import re

import cv2
import numpy as np

from app.config import get_settings

# VJUAK1 = a kỳ thi (its bộ đề trộn); VJUAK2 = an answer key uploaded from
# Excel (models/answer_key_share.py)
_TOKEN = re.compile(r"VJUAK([12]):(\d+)\.([a-z2-7]{16})")
_KIND = {"1": "answer-key", "2": "answer-share"}


def _sig(kind: str, ref: int) -> str:
    key = get_settings().jwt_secret_key.encode()
    mac = hmac.new(key, f"{kind}:{ref}".encode(), hashlib.sha256).digest()
    return base64.b32encode(mac).decode().lower()[:16]


def token(exam_id: int) -> str:
    return f"VJUAK1:{exam_id}.{_sig('answer-key', exam_id)}"


def share_token(share_id: int) -> str:
    return f"VJUAK2:{share_id}.{_sig('answer-share', share_id)}"


def parse(text: str) -> tuple[str, int] | None:
    """("exam" | "share", id) a scanned text points to; None when it isn't
    ours or the signature is forged."""
    m = _TOKEN.search((text or "").strip())
    if not m:
        return None
    ver, ref = m.group(1), int(m.group(2))
    if not hmac.compare_digest(m.group(3), _sig(_KIND[ver], ref)):
        return None
    return ("exam" if ver == "1" else "share", ref)


def exam_of(text: str) -> int | None:
    """The kỳ thi id a scanned text points to, None when it isn't one."""
    p = parse(text)
    return p[1] if p and p[0] == "exam" else None


def png(text: str, module_px: int = 12, border: int = 4) -> bytes:
    params = cv2.QRCodeEncoder_Params()
    params.correction_level = cv2.QRCODE_ENCODER_CORRECT_LEVEL_M
    q = cv2.QRCodeEncoder.create(params).encode(text)
    img = cv2.resize(q, (q.shape[1] * module_px, q.shape[0] * module_px), interpolation=cv2.INTER_NEAREST)
    pad = border * module_px
    img = cv2.copyMakeBorder(img, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=255)
    ok, buf = cv2.imencode(".png", img)
    if not ok:
        raise RuntimeError("Không tạo được ảnh QR")
    return buf.tobytes()


def decode(data: bytes) -> list[str]:
    """Every QR text found in a photo / screenshot (tries a few sizes and a
    thresholded copy — phone photos are large, blurry or unevenly lit)."""
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_GRAYSCALE)
    if img is None:
        return []
    det = cv2.QRCodeDetector()
    found: list[str] = []

    def add(t: str) -> None:
        if t and t not in found:
            found.append(t)

    h, w = img.shape[:2]
    for side in (1400, 900, 2200, max(h, w)):
        s = min(1.0, side / max(h, w)) if side != max(h, w) else 1.0
        im = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA) if s < 1 else img
        for cand in (im, cv2.adaptiveThreshold(im, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 51, 10)):
            try:
                ok, texts, _, _ = det.detectAndDecodeMulti(cand)
                if ok:
                    for t in texts:
                        add(t)
            except cv2.error:
                pass
            try:
                t, _, _ = det.detectAndDecode(cand)
                add(t)
            except cv2.error:
                pass
        if found:
            break
    return found
