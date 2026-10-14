from fastapi import APIRouter, Depends, Request
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.security.permissions import get_current_user, require_roles
from app.database import get_db
from app.models.batch_result import BatchResult
from app.models.user import User
from app.schemas.exam_schema import (
    AnswerKeyCreate,
    AnswerKeyOut,
    ExamCreate,
    ExamOut,
    ExamUpdate,
)
from app.services.audit_service import AuditService
from app.services.exam_service import ExamService

router = APIRouter(prefix="/exams", tags=["exams"])


def _ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _with_counts(db: Session, exams) -> list[ExamOut]:
    """graded_count = phiếu saved for the kỳ thi (Kết quả), counted from the
    results — the stored counter was only bumped by the old one-by-one
    grading API, so kỳ thi graded by batch / Chấm nhanh showed "0 phiếu"."""
    ids = [e.id for e in exams]
    counts = dict(
        db.query(BatchResult.exam_id, func.count(BatchResult.id))
        .filter(BatchResult.exam_id.in_(ids)).group_by(BatchResult.exam_id).all()
    ) if ids else {}
    out = []
    for e in exams:
        o = ExamOut.model_validate(e)
        o.graded_count = counts.get(e.id, 0)
        out.append(o)
    return out


@router.get("", response_model=list[ExamOut])
def list_exams(
    skip: int = 0,
    limit: int = 100,
    mine: bool = False,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    svc = ExamService(db)
    owner_id = current_user.id if mine or current_user.role == "teacher" else None
    return _with_counts(db, svc.list_exams(owner_id=owner_id, skip=skip, limit=limit))


@router.post("", response_model=ExamOut, status_code=201)
def create_exam(
    body: ExamCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles("admin", "teacher")),
):
    svc   = ExamService(db)
    audit = AuditService(db)
    exam  = svc.create_exam(owner_id=current_user.id, **body.model_dump(exclude_none=True))
    audit.log(
        "create_exam",
        user_id=current_user.id,
        resource_type="exam",
        resource_id=exam.id,
        details={"name": exam.name},
        ip_address=_ip(request),
    )
    return exam


@router.get("/{exam_id}", response_model=ExamOut)
def get_exam(
    exam_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    return _with_counts(db, [ExamService(db).get_or_404(exam_id)])[0]


@router.put("/{exam_id}", response_model=ExamOut)
def update_exam(
    exam_id: int,
    body: ExamUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles("admin", "teacher")),
):
    return ExamService(db).update_exam(
        exam_id, actor_id=current_user.id, **body.model_dump(exclude_none=True)
    )


@router.delete("/{exam_id}", status_code=204)
def delete_exam(
    exam_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles("admin", "teacher")),
):
    ExamService(db).delete_exam(exam_id, actor_id=current_user.id)


# ── Answer key sub-resource ─────────────────────────────────────────

@router.get("/{exam_id}/answer-key", response_model=AnswerKeyOut)
def get_answer_key(
    exam_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    return ExamService(db).get_answer_key_or_404(exam_id)


@router.put("/{exam_id}/answer-key", response_model=AnswerKeyOut)
def upsert_answer_key(
    exam_id: int,
    body: AnswerKeyCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_roles("admin", "teacher")),
):
    return ExamService(db).upsert_answer_key(
        exam_id, answers_json=body.answers_json, scoring_json=body.scoring_json
    )
