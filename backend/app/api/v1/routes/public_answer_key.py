"""
Mã QR đáp án opened on any device (2026-10-13) — no login.

"điện thoại, ipad, thiết bị khác quét thì phải ra file excel đáp án" / "Không
cần đăng nhập": the link in the QR (/qr?k=<token>) shows the đáp án and a
button to download them as Excel. Only a signed token (services/answer_qr.py)
opens anything, so ids can't be guessed — but whoever holds the QR can read
the answers, like the QM app's QR which carries them in clear.
"""
import io
import json
import re
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Response
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.answer_key_share import AnswerKeyShare
from app.models.exam import Exam
from app.models.user import User
from app.services import answer_qr
from app.services.exam_paper_service import ExamPaperService

router = APIRouter(prefix="/public/answer-key", tags=["public"])
# the link inside a mã QR đáp án: /api/v1/q/<token> = the Excel file
short_router = APIRouter(prefix="/q", tags=["public"])


def _load(token: str, db: Session) -> dict:
    """{title, kind, template{mode,id,name,variant}, byMaDe{code: {label: ans}}, scoring}
    — one entry "" in byMaDe when the đáp án isn't split by mã đề."""
    ref = answer_qr.parse(token)
    not_found = HTTPException(404, "Mã QR không phải mã đáp án của VJU Smart Grading, hoặc đáp án đã bị xóa")
    if ref is None:
        raise not_found
    if ref[0] == "share":
        row = db.get(AnswerKeyShare, ref[1])
        if row is None:
            raise not_found
        store = json.loads(row.store_json)
        by = {c: (s or {}).get("answers", {}) for c, s in (store.get("byMaDe") or {}).items()}
        by = {c: a for c, a in by.items() if any(a.values())}
        if not by:
            by = {"": store.get("answers", {})}
        return {"kind": "share", "title": row.name, "byMaDe": by, "scoring": store.get("scoring"),
                "template": {"mode": row.template_mode, "id": row.template_id, "name": row.template_name,
                             "variant": row.variant}}
    exam = db.get(Exam, ref[1])
    owner = db.get(User, exam.owner_id) if exam else None
    if exam is None or owner is None:
        raise not_found
    k = ExamPaperService(db, owner).exam_answer_key(exam.id, shared=True)
    sheets = k.get("sheets") or []
    sid = sheets[0] if len(set(sheets)) == 1 else None
    return {"kind": "exam", "title": exam.name, "byMaDe": k["byMaDe"], "scoring": None,
            "template": {"mode": "custom", "id": sid, "name": k.get("sheetNames", {}).get(str(sid)) if sid else None,
                         "variant": None}}


@router.get("/{token}")
def view(token: str, db: Session = Depends(get_db)):
    return _load(token, db)


_PART = re.compile(r"^(.*?)(\d+[a-dA-D]?)$")


def _rows(answers: dict[str, str]):
    """(STT, Phần n, câu số, label, đáp án) — parts follow the label prefixes
    (trc_nghim_abcd1… = Phần 1, the Đúng/Sai labels = Phần 2, …)."""
    part, last, n = 0, None, 0
    for i, (label, ans) in enumerate(answers.items(), 1):
        m = _PART.match(label)
        prefix, num = (m.group(1), m.group(2)) if m else (label, label)
        if re.fullmatch(r"\d{5,}", label):       # field ids of trả lời ngắn
            prefix = "#id"
        if prefix != last:
            part, last, n = part + 1, prefix, 0
        n += 1
        yield i, f"Phần {part}", (str(n) if prefix == "#id" else num), label, ans or ""


@router.get("/{token}/xlsx")
def excel(token: str, db: Session = Depends(get_db)):
    """The đáp án as Excel — same layout Answer Key → Nhập file đáp án reads
    back ("Đề 101" sheets, columns Câu / Đáp án)."""
    d = _load(token, db)
    wb = Workbook()
    wb.remove(wb.active)
    head_fill = PatternFill("solid", fgColor="C8102E")
    for code, answers in d["byMaDe"].items():
        ws = wb.create_sheet(f"Đề {code}"[:31] if code else "Đáp án")
        ws.append([d["title"] + (f" — mã đề {code}" if code else "")])
        ws["A1"].font = Font(bold=True, size=13)
        ws.append([d["template"].get("name") or ""])
        ws.append([])
        ws.append(["STT", "Phần", "Câu số", "Câu", "Đáp án"])
        for c in ws[4]:
            c.font, c.fill, c.alignment = Font(bold=True, color="FFFFFF"), head_fill, Alignment(horizontal="center")
        for row in _rows(answers):
            ws.append(list(row))
        for col, w in zip("ABCDE", (6, 9, 9, 22, 10)):
            ws.column_dimensions[col].width = w
    buf = io.BytesIO()
    wb.save(buf)
    title = re.sub(r"[^\w\- ]+", "", d["title"]).strip() or "QR"
    name = f"Dap an - {title}.xlsx"
    return Response(buf.getvalue(), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"})


@short_router.get("/{token}")
def excel_short(token: str, db: Session = Depends(get_db)):
    """Camera quét mã QR → tải ngay file Excel đáp án."""
    return excel(token, db)
