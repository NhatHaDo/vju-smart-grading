"""
grading.py — OMR grading endpoints.

Routes:
    POST   /sheets/{sheet_id}/grade          — run OMR, grade, save result
    GET    /sheets/{sheet_id}/result         — fetch stored grading result
    GET    /sheets/{sheet_id}/debug-overlay  — serve debug overlay image
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.core.security.permissions import get_current_user, require_roles
from app.database import get_db
from app.models.user import User
from app.services.grading_service import GradingService

router = APIRouter(tags=["grading"])


# ── POST /sheets/{sheet_id}/grade ─────────────────────────────────────────

@router.post(
    "/sheets/{sheet_id}/grade",
    summary="Chấm OMR cho một phiếu",
    status_code=200,
)
def grade_sheet(
    sheet_id: int,
    mean_mode: str = Query(
        default="circle_mask",
        description="Phương pháp đo bubble: 'circle_mask' (mặc định) hoặc 'rect'",
    ),
    save_debug: bool = Query(
        default=True,
        description="Lưu debug overlay image",
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles("admin", "teacher")),
) -> dict:
    """
    Chạy OMR pipeline:
    1. Load ảnh từ disk theo sheet.file_path
    2. CropOnMarkers → resize → bubble analysis
    3. Detect answers + student info
    4. Tính điểm nếu exam có answer key
    5. Lưu GradingResult vào DB
    6. Trả JSON kết quả

    **Response fields:**
    - `student_info`: CCCD, SBD, MaDe, CaThi, MaCTDT, TuChon
    - `answers`: {toan1: "A", ...}
    - `warnings`: [{field, type, candidates}]
    - `score`: {total, max, correct, wrong, blank}
    - `debug`: {prep_method, threshold, overlay_path, ...}
    """
    svc = GradingService(db)
    return svc.grade_sheet(
        sheet_id=sheet_id,
        mean_mode=mean_mode,
        save_debug_overlay=save_debug,
    )


# ── GET /sheets/{sheet_id}/result ────────────────────────────────────────

@router.get(
    "/sheets/{sheet_id}/result",
    summary="Lấy kết quả chấm đã lưu",
)
def get_grading_result(
    sheet_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict:
    """
    Trả kết quả chấm đã lưu trong DB cho phiếu `sheet_id`.
    Trả 404 nếu phiếu chưa được chấm.
    """
    return GradingService(db).get_result(sheet_id)


# ── GET /sheets/{sheet_id}/debug-overlay ────────────────────────────────

@router.get(
    "/sheets/{sheet_id}/debug-overlay",
    summary="Tải debug overlay image",
)
def get_debug_overlay(
    sheet_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> FileResponse:
    """
    Trả file debug overlay JPG cho phiếu đã chấm.
    File này được tạo tự động trong thư mục `outputs/debug_overlays/` khi grade.
    """
    from app.config import get_settings
    settings = get_settings()

    overlay_path = (
        Path(settings.omr_output_dir) / "debug_overlays" / f"sheet_{sheet_id}_overlay.jpg"
    )

    if not overlay_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Debug overlay chưa tạo. Hãy chấm phiếu trước (POST /grade với save_debug=true)",
        )

    return FileResponse(
        path=str(overlay_path),
        media_type="image/jpeg",
        filename=f"sheet_{sheet_id}_debug_overlay.jpg",
    )
