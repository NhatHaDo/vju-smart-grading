"""
Trộn đề — bộ đề (sets of shuffled mã đề) built from the question bank or
from one uploaded đề file; Word export; attach to a kỳ thi; answer key per
mã đề for grading. See app/services/exam_mixer.py for the mixing rules.
"""
import io
import re
import zipfile
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.security.permissions import require_roles
from app.database import get_db
from app.models.user import User
from app.services.exam_mixer import PART_LIMITS, Snapshot, answer_key_docx, usable
from app.services.exam_paper_service import ExamPaperService
from app.services.question_bank_service import _fingerprint
from app.services import question_assets as qa
from app.services.question_io import LOST, QTYPES, apply_picked_answers, decode_text, mcq_rows, parse_docx, parse_txt
from app.services.sheet_layouts import list_layouts

router = APIRouter(prefix="/exam-papers", tags=["exam-papers"])

MAX_UPLOAD_BYTES = 10 * 1024 * 1024
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def _svc(db: Session = Depends(get_db), user: User = Depends(require_roles("admin", "teacher"))) -> ExamPaperService:
    return ExamPaperService(db, user)


class Counts(BaseModel):
    mcq:   int = 0
    tf:    int = 0
    short: int = 0


class FromBankIn(BaseModel):
    name:              str
    category_ids:      list[int]
    counts:            Counts
    num_versions:      int = Field(4, ge=1, le=24)
    start_code:        str = "101"
    shuffle_questions: bool = True
    shuffle_options:   bool = True
    exam_id:           int | None = None
    for_sheet:         bool = True     # chấm bằng phiếu (số câu, số đáp án theo phiếu)
    # the answer sheet: a template id from GET /exam-papers/sheets ("mau40" /
    # "bgd" = the shared ones, as sent before 2026-10-05); None = Mẫu 40
    sheet:             int | Literal["mau40", "bgd"] | None = None


class PaperUpdate(BaseModel):
    name:    str | None = None
    exam_id: int | None = None
    # 2026-10-06: the answer sheet the bộ đề is graded on (template id from
    # GET /exam-papers/sheets) — a bộ đề mixed for the wrong sheet (or before
    # the sheet could be picked) is switched without mixing again
    sheet:   int | None = None


class VersionUpdate(BaseModel):
    in_exam: bool


def _file_response(content: bytes, filename: str, media: str) -> Response:
    return Response(content, media_type=media, headers={
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
    })


def _safe(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|]+', "_", name).strip() or "de-thi"


# ── List / create ────────────────────────────────────────────────────────────

@router.get("")
def list_papers(exam_id: int | None = None, svc: ExamPaperService = Depends(_svc)):
    return svc.list_papers(exam_id)


@router.post("/from-bank", status_code=201)
def create_from_bank(body: FromBankIn, svc: ExamPaperService = Depends(_svc)):
    paper, notes = svc.create_from_bank(
        name=body.name, category_ids=body.category_ids, counts=body.counts.model_dump(),
        num_versions=body.num_versions, start_code=body.start_code,
        shuffle_questions=body.shuffle_questions, shuffle_options=body.shuffle_options, exam_id=body.exam_id,
        for_sheet=body.for_sheet, sheet=body.sheet)
    return {**svc.to_dict(paper), "notes": notes}


MAX_FILES = 20


def _parse_one(fname: str, data: bytes):
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"File \"{fname}\" quá lớn (tối đa 10MB)")
    if fname.lower().endswith(".docx"):
        # questions without a marked answer are kept (answer -1): the teacher
        # picks their answers on the page (parse-file lists them)
        return parse_docx(data, allow_unanswered=True)
    if fname.lower().endswith(".txt"):
        # written like the Word file, or a Moodle (Aiken) export
        return parse_txt(decode_text(data), allow_unanswered=True)
    raise HTTPException(400, f"\"{fname}\": chỉ hỗ trợ file .docx (Word) hoặc .txt (Moodle)")


async def _read_questions(files: list[UploadFile], db: Session | None = None):
    """Read one or several đề files into one pool of questions, in file order
    (several files = the questions of all of them, e.g. one file per chương).
    An exact repeat of an earlier câu (same text and options, like the ngân
    hàng's import) is dropped, so a mã đề never has the same câu twice; the
    5th value says which câu were dropped and what they repeat."""
    if not files:
        raise HTTPException(400, "Chọn file đề")
    if len(files) > MAX_FILES:
        raise HTTPException(400, f"Tối đa {MAX_FILES} file mỗi lần")
    many = len(files) > 1
    questions, warnings, names = [], [], []
    source_docx = None
    for f in files:
        fname = f.filename or ""
        data = await f.read()
        qs, ws = _parse_one(fname, data)
        if not many and fname.lower().endswith(".docx"):
            source_docx = data      # one Word file → mã đề built from it, format kept
        if many:   # say which file a warning is about; keep groups of different files apart
            ws = [f"{fname}: {w}" for w in ws]
            offset = max((q.group for q in questions if q.group is not None), default=-1) + 1
            for q in qs:
                q.where = f"{fname}: {q.where}" if q.where else fname
                if q.group is not None:
                    q.group += offset
        questions += qs
        warnings += ws
        names.append(fname)
    if not questions:
        raise HTTPException(422, _why_nothing_read(warnings))
    seen, kept, duplicates = {}, [], []
    for q in questions:
        fp = _fingerprint(q.qtype, q.content, q.options)
        if fp in seen:
            short = q.content[:60] + ("…" if len(q.content) > 60 else "")
            duplicates.append(f'{q.where or "Câu"} "{short}": trùng {seen[fp].where or "một câu khác"}')
            continue
        seen[fp] = q
        kept.append(q)
    questions = kept
    if source_docx is not None:
        # formulas/pictures are kept, so those warnings don't apply
        warnings = [w for w in warnings if LOST not in w]
    # formulas/pictures of the questions: kept so the page and the mã đề show them
    note = qa.NO_SVG_NOTE if db is not None and qa.save(db, qa.assets_of(questions)) else None
    return ", ".join(names), questions, warnings, source_docx, duplicates, note


# What a warning is about → how to say it to the teacher, most important first.
_WARNING_KINDS = [
    ("chưa đánh dấu đáp án đúng",
     "{n} câu chưa đánh dấu đáp án đúng (tô đỏ hoặc gạch chân chữ cái đáp án đúng, hoặc thêm dòng \"Đáp án: B\")"),
    ("không tìm thấy đáp án A./B.", "{n} câu không có phương án A/B/C/D"),
    ("không có phương án A/B/C/D", "{n} câu không có phương án A/B/C/D"),
    ("có bảng", "{n} câu có bảng, bảng sẽ bị mất khi trộn dạng chữ"),
]


def _why_nothing_read(warnings: list[str]) -> str:
    """One readable reason for "no question read", counted per kind — not the
    first warning of the file (which was often a side issue: a formula)."""
    if not warnings:
        return ("Không đọc được câu hỏi nào trong file. Câu hỏi phải bắt đầu bằng \"Câu 1.\" hoặc \"1.\", "
                "đáp án bắt đầu bằng \"A.\" \"B.\"…")
    counts: dict[str, int] = {}
    other = 0
    for w in warnings:
        kind = next((msg for key, msg in _WARNING_KINDS if key in w), None)
        if kind is None:
            other += 1
        else:
            counts[kind] = counts.get(kind, 0) + 1
    parts = [msg.format(n=counts[msg]) for _, msg in _WARNING_KINDS if msg in counts]
    parts = list(dict.fromkeys(parts))
    if other:
        parts.append(f"{other} câu lỗi khác, ví dụ: {next(w for w in warnings if not any(k in w for k, _ in _WARNING_KINDS))}")
    return "Không đọc được câu hỏi nào trong file. " + "; ".join(parts) + "."


@router.post("/parse-file")
async def parse_file(file: list[UploadFile] = File(...), svc: ExamPaperService = Depends(_svc)):
    """Đọc thử (các) file đề: số câu dùng được mỗi phần, để chọn lấy bao nhiêu câu."""
    _, questions, warnings, source_docx, duplicates, note = await _read_questions(file, svc.db)
    answered = [q for q in questions if not (q.qtype == "mcq" and q.answer < 0)]
    rows = mcq_rows(questions)
    ok = [q for q in answered if usable(q)]
    return {
        "keeps_format": source_docx is not None,
        # trắc nghiệm questions with no answer marked; "i" = position in this
        # file set, sent back as answers_json when mixing
        "unanswered": [r for r in rows if r["answer"] < 0],
        "mcq_all": rows,           # every trắc nghiệm, for the file đáp án
        "available":     {qt: sum(1 for q in ok if q.qtype == qt) for qt in QTYPES},         # dùng được trên phiếu
        "available_all": {qt: sum(1 for q in questions if q.qtype == qt) for qt in QTYPES},  # đề chỉ để in
        "limits":        PART_LIMITS,
        "too_many_options": len(questions) - len(ok),
        "too_many_options_list": [
            f"{q.where or 'Câu'} \"{q.content[:60]}{'…' if len(q.content) > 60 else ''}\": {len(q.options)} đáp án"
            for q in questions if not usable(q)],
        "warnings":  warnings,
        "duplicate_list": duplicates,      # exact repeats, left out of the pool
        "formula_note": note,              # formulas kept but not drawable on the web (no LibreOffice)
    }


@router.post("/from-file", status_code=201)
async def create_from_file(
    file: list[UploadFile] = File(...),
    name: str = Form(...),
    num_versions: int = Form(4, ge=1, le=24),
    start_code: str = Form("101"),
    shuffle_questions: bool = Form(True),
    shuffle_options: bool = Form(True),
    exam_id: int | None = Form(None),
    count_mcq: int | None = Form(None, ge=0),
    count_tf: int | None = Form(None, ge=0),
    count_short: int | None = Form(None, ge=0),
    for_sheet: bool = Form(True),
    sheet: str | None = Form(None),     # template id (see FromBankIn.sheet)
    answers_json: str | None = Form(None),
    svc: ExamPaperService = Depends(_svc),
):
    """Mix đề file(s) directly (không cần đưa vào ngân hàng): .docx with
    PHẦN I-II/III/IV, or a Moodle .txt (trắc nghiệm only); several files are pooled. count_* = lấy ngẫu nhiên
    bấy nhiêu câu mỗi phần (bỏ trống cả 3 → lấy hết)."""
    fname, questions, warnings, source_docx, duplicates, note = await _read_questions(file, svc.db)
    # đáp án the teacher picked on the page for unmarked questions: {"12": 2}
    try:
        apply_picked_answers(questions, answers_json)
    except ValueError:
        raise HTTPException(422, "answers_json không hợp lệ")
    given = {"mcq": count_mcq, "tf": count_tf, "short": count_short}
    counts = None if all(v is None for v in given.values()) else {qt: v or 0 for qt, v in given.items()}
    paper, notes = svc.create_from_questions(
        name=name, questions=questions, file_name=fname, num_versions=num_versions, start_code=start_code,
        shuffle_questions=shuffle_questions, shuffle_options=shuffle_options, exam_id=exam_id, counts=counts,
        for_sheet=for_sheet, source_docx=source_docx, sheet=sheet or None)
    if duplicates:
        warnings = warnings + [f"Đã bỏ {len(duplicates)} câu trùng (giống hệt một câu khác trong file)"]
    if note and not source_docx:
        warnings = warnings + [note]
    return {**svc.to_dict(paper), "notes": warnings + notes}


# ── For grading (step 6.2) — declared before /{paper_id} ─────────────────────

@router.get("/sheets")
def answer_sheets(svc: ExamPaperService = Depends(_svc)):
    """The answer sheets a bộ đề can be mixed for — the shared ones, then the
    teacher's own custom templates — with what each holds (sheet_layouts.py)."""
    return [lay.to_dict() for lay in list_layouts(svc.db, svc.user.id)]


@router.get("/exam-answer-key/{exam_id}")
def exam_answer_key(exam_id: int, sheet: str | None = None, svc: ExamPaperService = Depends(_svc)):
    """Answer key per mã đề of every bộ đề attached to this kỳ thi, in the
    grading labels of its answer sheet; sheet (template id) = only the bộ đề
    mixed for it."""
    return svc.exam_answer_key(exam_id, sheet)


# ── One bộ đề ────────────────────────────────────────────────────────────────

@router.get("/{paper_id}")
def get_paper(paper_id: int, svc: ExamPaperService = Depends(_svc)):
    return svc.to_dict(svc.get_or_404(paper_id), with_questions=True)


@router.put("/{paper_id}")
def update_paper(paper_id: int, body: PaperUpdate, svc: ExamPaperService = Depends(_svc)):
    return svc.to_dict(svc.update(paper_id, body.model_dump(exclude_unset=True)))


@router.put("/{paper_id}/versions/{version_id}")
def update_version(paper_id: int, version_id: int, body: VersionUpdate, svc: ExamPaperService = Depends(_svc)):
    return svc.to_dict(svc.set_version_in_exam(paper_id, version_id, body.in_exam))


@router.delete("/{paper_id}", status_code=204)
def delete_paper(paper_id: int, svc: ExamPaperService = Depends(_svc)):
    svc.delete(paper_id)


# ── Word export ──────────────────────────────────────────────────────────────

def _versions(svc: ExamPaperService, paper_id: int):
    p = svc.get_or_404(paper_id)
    d = svc.to_dict(p, with_questions=True)
    subtitle = f"Kỳ thi: {d['exam_name']}" if d["exam_name"] else ""
    return p, subtitle, {v["code"]: [Snapshot.from_dict(q) for q in v["questions"]] for v in d["versions"]}


@router.get("/{paper_id}/versions/{code}/docx")
def export_version(paper_id: int, code: str, svc: ExamPaperService = Depends(_svc)):
    p, subtitle, versions = _versions(svc, paper_id)
    if code not in versions:
        raise HTTPException(404, "Không tìm thấy mã đề")
    return _file_response(svc.version_word(p, code, versions[code], subtitle),
                          f"{_safe(p.name)} - Ma de {_safe(code)}.docx", DOCX)


@router.get("/{paper_id}/answer-key/docx")
def export_answer_key(paper_id: int, svc: ExamPaperService = Depends(_svc)):
    p, _, versions = _versions(svc, paper_id)
    return _file_response(answer_key_docx(p.name, versions), f"{_safe(p.name)} - Dap an.docx", DOCX)


@router.get("/{paper_id}/zip")
def export_zip(paper_id: int, svc: ExamPaperService = Depends(_svc)):
    """Every mã đề + the đáp án, one .zip."""
    p, subtitle, versions = _versions(svc, paper_id)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for code, snaps in versions.items():
            z.writestr(f"Ma de {_safe(code)}.docx", svc.version_word(p, code, snaps, subtitle))
        z.writestr("Dap an.docx", answer_key_docx(p.name, versions))
    return _file_response(buf.getvalue(), f"{_safe(p.name)}.zip", "application/zip")
