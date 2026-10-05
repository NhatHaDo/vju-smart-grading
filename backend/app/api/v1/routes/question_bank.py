"""
Ngân hàng câu hỏi — categories + multiple-choice questions, with Aiken .txt /
Word .docx import & export. See app/services/question_io.py for formats.
"""
import re
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.security.permissions import require_roles
from app.database import get_db
from app.models.user import User
from app.schemas.question_bank_schema import (
    CategoryCreate,
    CategoryOut,
    CategoryUpdate,
    ImportResult,
    QuestionIn,
    QuestionOut,
    ShareCreate,
    ShareOut,
)
from app.models.question_asset import QuestionAsset
from app.services import question_assets as qa
from app.services.question_bank_service import QuestionBankService, question_to_dict, question_to_parsed
from app.services.question_io import (
    apply_picked_answers,
    export_aiken,
    export_docx,
    mcq_rows,
    decode_text,
    parse_txt,
    parse_docx,
)

router = APIRouter(prefix="/question-bank", tags=["question-bank"])

MAX_IMPORT_BYTES = 10 * 1024 * 1024

_teacher = require_roles("admin", "teacher")


def _svc(db: Session = Depends(get_db), user: User = Depends(_teacher)) -> QuestionBankService:
    return QuestionBankService(db, user)


# ── Categories ───────────────────────────────────────────────────────────────

@router.get("/categories", response_model=list[CategoryOut])
def list_categories(svc: QuestionBankService = Depends(_svc)):
    return svc.list_categories()


@router.post("/categories", response_model=CategoryOut, status_code=201)
def create_category(body: CategoryCreate, svc: QuestionBankService = Depends(_svc)):
    return svc.create_category(body.name, body.description)


@router.put("/categories/{category_id}", response_model=CategoryOut)
def update_category(category_id: int, body: CategoryUpdate, svc: QuestionBankService = Depends(_svc)):
    return svc.update_category(category_id, **body.model_dump(exclude_unset=True))


@router.delete("/categories/{category_id}", status_code=204)
def delete_category(category_id: int, svc: QuestionBankService = Depends(_svc)):
    svc.delete_category(category_id)


@router.post("/categories/{category_id}/copy", response_model=CategoryOut, status_code=201)
def copy_category(category_id: int, svc: QuestionBankService = Depends(_svc)):
    """Copy a category (e.g. one shared with me) into my own bank."""
    return svc.copy_category(category_id)


# ── Sharing ──────────────────────────────────────────────────────────────────

@router.get("/categories/{category_id}/shares", response_model=list[ShareOut])
def list_shares(category_id: int, svc: QuestionBankService = Depends(_svc)):
    return svc.list_shares(category_id)


@router.post("/categories/{category_id}/shares", response_model=list[ShareOut])
def share_category(category_id: int, body: ShareCreate, svc: QuestionBankService = Depends(_svc)):
    """Share with another account by email; sharing again updates the permission."""
    return svc.share(category_id, body.email, body.permission)


@router.delete("/categories/{category_id}/shares/{share_id}", status_code=204)
def unshare_category(category_id: int, share_id: int, svc: QuestionBankService = Depends(_svc)):
    svc.unshare(category_id, share_id)


# ── Questions ────────────────────────────────────────────────────────────────

@router.get("/categories/{category_id}/questions", response_model=list[QuestionOut])
def list_questions(
    category_id: int,
    q: str | None = None,
    qtype: str | None = Query(None, pattern="^(mcq|tf|short)$"),
    unanswered: bool = False,
    svc: QuestionBankService = Depends(_svc),
):
    rows = svc.list_questions(category_id, q, qtype, unanswered)
    # formulas imported while the server couldn't draw them (no LibreOffice yet): drawn now
    qa.render_missing(svc.db, qa.ids_in_questions([question_to_parsed(x) for x in rows]))
    return [question_to_dict(x) for x in rows]


@router.post("/categories/{category_id}/questions", response_model=QuestionOut, status_code=201)
def create_question(category_id: int, body: QuestionIn, svc: QuestionBankService = Depends(_svc)):
    return question_to_dict(svc.create_question(category_id, body.model_dump(exclude_none=True)))


@router.put("/questions/{question_id}", response_model=QuestionOut)
def update_question(question_id: int, body: QuestionIn, svc: QuestionBankService = Depends(_svc)):
    return question_to_dict(svc.update_question(question_id, body.model_dump(exclude_none=True)))


class AnswerIn(BaseModel):
    answer: int      # option index, -1 = chưa có đáp án


@router.put("/questions/{question_id}/answer", response_model=QuestionOut)
def set_answer(question_id: int, body: AnswerIn, svc: QuestionBankService = Depends(_svc)):
    """Quick pick of the correct option (questions imported without one)."""
    return question_to_dict(svc.set_answer(question_id, body.answer))


@router.delete("/questions/{question_id}", status_code=204)
def delete_question(question_id: int, svc: QuestionBankService = Depends(_svc)):
    svc.delete_question(question_id)


# ── Import / export ──────────────────────────────────────────────────────────

@router.post("/categories/{category_id}/import", response_model=ImportResult)
async def import_questions(
    category_id: int,
    file: UploadFile = File(...),
    dry_run: bool = Query(False, description="Chỉ xem trước, không lưu"),
    answers_json: str | None = Form(None),
    svc: QuestionBankService = Depends(_svc),
):
    svc.get_category_or_404(category_id, need="edit")
    data = await file.read()
    if len(data) > MAX_IMPORT_BYTES:
        raise HTTPException(413, "File quá lớn (tối đa 10MB)")

    name = (file.filename or "").lower()
    if name.endswith(".docx"):
        # a question with no answer marked is imported anyway: pick it on the page
        parsed, warnings = parse_docx(data, allow_unanswered=True)
    elif name.endswith(".txt"):
        # written like the Word file, or a Moodle (Aiken) export
        parsed, warnings = parse_txt(decode_text(data), allow_unanswered=True)
    else:
        raise HTTPException(400, "Chỉ hỗ trợ file .txt hoặc .docx (Word)")

    # đáp án picked on the page for trắc nghiệm the file doesn't mark: {"12": 2}
    try:
        apply_picked_answers(parsed, answers_json)
    except ValueError:
        raise HTTPException(422, "answers_json không hợp lệ")

    # formulas/pictures: kept (also on a dry run, so the preview shows them)
    no_svg = qa.save(svc.db, qa.assets_of(parsed))
    r = svc.import_questions(category_id, parsed, dry_run)
    rows, needs = mcq_rows(parsed), set(r["needs_answer"])
    return ImportResult(dry_run=dry_run, found=len(parsed), new=r["new"], duplicates=r["duplicates"], duplicate_list=r["duplicate_list"],
                        unanswered=len(r["needs_answer"]), answered=r["answered"],
                        unanswered_list=[x for x in rows if x["i"] in needs], mcq_all=rows,
                        warnings=warnings, formula_note=qa.NO_SVG_NOTE if no_svg else None)


@router.get("/categories/{category_id}/export")
def export_questions(
    category_id: int,
    format: str = Query("txt", pattern="^(txt|docx)$"),
    svc: QuestionBankService = Depends(_svc),
):
    category  = svc.get_category_or_404(category_id)
    questions = [question_to_parsed(q) for q in svc.list_questions(category_id)]
    base = re.sub(r'[\\/:*?"<>|]+', "_", category.name).strip() or "ngan-hang-cau-hoi"

    if format == "docx":
        content = export_docx(questions, title=category.name,
                              assets=qa.load(svc.db, qa.ids_in_questions(questions)))
        media   = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    else:
        content = export_aiken(questions).encode("utf-8")
        media   = "text/plain; charset=utf-8"

    filename = f"{base}.{format}"
    return Response(content, media_type=media, headers={
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
    })


# ── Công thức / hình ảnh of questions, for <img> on the page ─────────────────
# No login check: <img> can't send the token, and an id is a 24-hex hash of the
# formula's content, not something to guess or list.
@router.get("/assets/{asset_id}.svg")
def asset_svg(asset_id: str, db: Session = Depends(get_db)):
    row = db.get(QuestionAsset, asset_id) if re.fullmatch(r"[0-9a-f]{8,40}", asset_id) else None
    if row is None or not row.svg:
        raise HTTPException(404, "Không có hình")
    return Response(row.svg, media_type="image/svg+xml",
                    headers={"Cache-Control": "public, max-age=31536000, immutable"})
