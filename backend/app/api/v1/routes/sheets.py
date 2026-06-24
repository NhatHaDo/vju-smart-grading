from fastapi import APIRouter, Depends, Request, UploadFile, File
from sqlalchemy.orm import Session

from app.core.security.permissions import get_current_user, require_roles
from app.database import get_db
from app.models.user import User
from app.schemas.sheet_schema import SheetOut
from app.services.audit_service import AuditService
from app.services.sheet_service import SheetService

router = APIRouter(tags=["sheets"])


def _ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


# ── Exam-scoped ──────────────────────────────────────────────────────

@router.get("/exams/{exam_id}/sheets", response_model=list[SheetOut])
def list_sheets(
    exam_id: int,
    skip: int = 0,
    limit: int = 200,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    return SheetService(db).list_by_exam(exam_id, skip=skip, limit=limit)


@router.post("/exams/{exam_id}/sheets/upload", response_model=SheetOut, status_code=201)
async def upload_sheet(
    exam_id: int,
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles("admin", "teacher")),
):
    """
    Upload a scanned answer sheet image (PNG/JPG/PDF).
    Phase 3: saves file, creates Sheet record (status=pending).
    Phase 4: will trigger OMR pipeline.
    """
    svc   = SheetService(db)
    audit = AuditService(db)
    sheet = await svc.upload_sheet(
        exam_id=exam_id,
        file=file,
        uploaded_by=current_user.id,
    )
    audit.log(
        "upload_sheet",
        user_id=current_user.id,
        resource_type="sheet",
        resource_id=sheet.id,
        details={"exam_id": exam_id, "original_filename": sheet.original_filename},
        ip_address=_ip(request),
    )
    return sheet


# ── Sheet-level ──────────────────────────────────────────────────────

@router.get("/sheets/{sheet_id}", response_model=SheetOut)
def get_sheet(
    sheet_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    return SheetService(db).get_or_404(sheet_id)


@router.delete("/sheets/{sheet_id}", status_code=204)
def delete_sheet(
    sheet_id: int,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles("admin", "teacher")),
):
    audit = AuditService(db)
    SheetService(db).delete_sheet(sheet_id)
    audit.log(
        "delete_sheet",
        user_id=current_user.id,
        resource_type="sheet",
        resource_id=sheet_id,
        ip_address=_ip(request),
    )
