import json
import logging
import random
import secrets
from pathlib import Path

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.exam import Exam
from app.models.exam_paper import ExamPaper, ExamPaperVersion
from app.models.question_bank import Question
from app.models.user import User
from app.services.exam_mixer import (
    MixError,
    Snapshot,
    answer_key,
    build_versions,
    check_counts,
    grading_key,
    sheet_problem,
    usable,
    version_codes,
    version_docx,
)
from app.services import question_assets as qa
from app.services.question_bank_service import QuestionBankService, question_to_parsed
from app.services.question_io import PART_OF, QTYPES, ParsedQuestion
from app.services.sheet_layouts import SheetLayout, get_layout

logger = logging.getLogger(__name__)

# The teacher's Word file of a bộ đề trộn giữ định dạng (docx_mixer): kept so
# every download rebuilds the mã đề from it, formulas and pictures included.
SOURCES_DIR = Path(__file__).resolve().parents[2] / "data" / "exam_paper_sources"


def source_path(settings: dict) -> Path | None:
    name = settings.get("source_file")
    if not name or "/" in name or "\\" in name:
        return None
    return SOURCES_DIR / name


def plan_of(snaps: list[Snapshot]) -> list[dict]:
    return [{"src": s.src, "qtype": s.qtype, "perm": s.perm} for s in snaps]


def _snaps(v: ExamPaperVersion) -> list[Snapshot]:
    return [Snapshot.from_dict(d) for d in json.loads(v.questions_json or "[]")]


class ExamPaperService:
    """A teacher sees their own bộ đề; admins see all."""

    def __init__(self, db: Session, user: User) -> None:
        self.db   = db
        self.user = user

    # ── Access ────────────────────────────────────────────────────────────
    def _mine(self, owner_id: int) -> bool:
        return self.user.role == "admin" or owner_id == self.user.id

    def get_or_404(self, paper_id: int) -> ExamPaper:
        p = self.db.get(ExamPaper, paper_id)
        if not p or not self._mine(p.owner_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy bộ đề")
        return p

    def _exam_or_404(self, exam_id: int) -> Exam:
        e = self.db.get(Exam, exam_id)
        if not e or not self._mine(e.owner_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy kỳ thi")
        return e

    # ── Answer sheet ──────────────────────────────────────────────────────
    def _layout(self, sheet: object) -> SheetLayout:
        """The answer sheet picked when mixing (a template id; None = Mẫu 40)."""
        lay = get_layout(self.db, sheet, self.user.id, check_access=True)
        if lay is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                "Không tìm thấy phiếu trả lời này, hoặc phiếu chưa có ô đáp án nào")
        return lay

    def paper_layout(self, p: ExamPaper) -> SheetLayout | None:
        """The sheet a bộ đề is graded on; None = chỉ in đề, or its sheet is gone."""
        settings = json.loads(p.settings_json or "{}")
        if not settings.get("for_sheet", True):
            return None
        return get_layout(self.db, settings.get("sheet"))

    def grading_layout(self, p: ExamPaper) -> SheetLayout | None:
        """The sheet to grade a bộ đề with: its own, or Mẫu 40 for a đề chỉ để
        in that still fits it (as before 2026-10-05)."""
        settings = json.loads(p.settings_json or "{}")
        return self.paper_layout(p) if settings.get("for_sheet", True) else get_layout(self.db, None)

    def _problem(self, p: ExamPaper, snaps: list[Snapshot], code: str = "0") -> str | None:
        lay = self.grading_layout(p)
        if lay is None:
            return "phiếu trả lời của bộ đề đã bị xóa"
        return sheet_problem(snaps, code, lay)

    # ── Output shape ──────────────────────────────────────────────────────
    def to_dict(self, p: ExamPaper, with_questions: bool = False) -> dict:
        settings = json.loads(p.settings_json or "{}")
        lay = self.paper_layout(p)
        exam = self.db.get(Exam, p.exam_id) if p.exam_id else None
        versions = []
        for v in p.versions:
            snaps = _snaps(v)
            d = {"id": v.id, "code": v.code, "in_exam": v.in_exam, "answer_key": answer_key(snaps)}
            if with_questions:
                d["questions"] = [s.to_dict() for s in snaps]
            versions.append(d)
        first = _snaps(p.versions[0]) if p.versions else []
        problem = next((pr for v in p.versions if (pr := self._problem(p, first, v.code))), None) \
            if p.versions else self._problem(p, first)
        return {
            "id": p.id, "name": p.name, "source": p.source, "owner_id": p.owner_id,
            "exam_id": p.exam_id, "exam_name": exam.name if exam else None,
            "settings": settings,
            "counts": {qt: sum(1 for s in first if s.qtype == qt) for qt in QTYPES},
            "gradable": problem is None, "sheet_problem": problem,
            # 2026-10-05: the answer sheet it is graded on (template id + name,
            # see sheet_layouts.py). None = chỉ in đề
            "sheet": lay.id if lay else None,
            "sheet_name": lay.name if lay else None,
            "versions": versions,
            "created_at": p.created_at, "updated_at": p.updated_at,
        }

    def list_papers(self, exam_id: int | None = None) -> list[dict]:
        q = self.db.query(ExamPaper)
        if self.user.role != "admin":
            q = q.filter(ExamPaper.owner_id == self.user.id)
        if exam_id is not None:
            q = q.filter(ExamPaper.exam_id == exam_id)
        return [self.to_dict(p) for p in q.order_by(ExamPaper.created_at.desc(), ExamPaper.id.desc()).all()]

    # ── Create ────────────────────────────────────────────────────────────
    def _save(self, name: str, source: str, settings: dict, questions: list[ParsedQuestion],
              num_versions: int, start_code: str, shuffle_questions: bool, shuffle_options: bool,
              exam_id: int | None, for_sheet: bool = True, layout: SheetLayout | None = None) -> ExamPaper:
        if not name.strip():
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Nhập tên bộ đề")
        if exam_id is not None:
            self._exam_or_404(exam_id)
        try:
            codes = version_codes(start_code, num_versions, for_sheet, layout)
        except MixError as e:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e))
        seed = secrets.randbits(32)
        versions = build_versions(questions, codes, shuffle_questions=shuffle_questions,
                                  shuffle_options=shuffle_options, seed=seed)
        if exam_id is not None:
            for code, snaps in versions.items():
                self._check_gradable(snaps, code, layout)
        if for_sheet and layout is not None and layout.id:    # 0 = Mẫu 40 read from its files
            settings = {**settings, "sheet": layout.id}
        paper = ExamPaper(
            owner_id=self.user.id, name=name.strip(), exam_id=exam_id, source=source,
            settings_json=json.dumps({**settings, "num_versions": num_versions, "start_code": start_code,
                                      "shuffle_questions": shuffle_questions, "shuffle_options": shuffle_options,
                                      "seed": seed}, ensure_ascii=False),
        )
        paper.versions = [
            ExamPaperVersion(code=code, questions_json=json.dumps([s.to_dict() for s in snaps], ensure_ascii=False))
            for code, snaps in versions.items()
        ]
        self.db.add(paper)       # one transaction: the set and all its versions
        self.db.commit()
        self.db.refresh(paper)
        return paper

    def create_from_bank(self, *, name: str, category_ids: list[int], counts: dict[str, int],
                         num_versions: int, start_code: str, shuffle_questions: bool,
                         shuffle_options: bool, exam_id: int | None,
                         for_sheet: bool = True, sheet: object = None) -> tuple[ExamPaper, list[str]]:
        """Pick `counts` random questions per part from the categories (own or
        shared with me), the same questions in every version. for_sheet →
        fit the answer sheet `sheet` (template id, None = Mẫu 40; see exam_mixer)."""
        layout = self._layout(sheet) if for_sheet else None
        if not category_ids:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Chọn ít nhất 1 danh mục câu hỏi")
        bank = QuestionBankService(self.db, self.user)
        cats = [bank.get_category_or_404(cid, need="view") for cid in dict.fromkeys(category_ids)]
        rows = (self.db.query(Question).filter(Question.category_id.in_([c.id for c in cats]))
                .order_by(Question.id).all())
        pool = [question_to_parsed(r) for r in rows]
        notes: list[str] = []
        if for_sheet:      # no answer yet → can't be graded on the sheet
            unanswered = [q for q in pool if q.qtype == "mcq" and q.answer < 0]
            if unanswered:
                pool = [q for q in pool if not (q.qtype == "mcq" and q.answer < 0)]
                notes.append(f"{len(unanswered)} câu chưa có đáp án trong ngân hàng không được dùng")
        skipped = [q for q in pool if not usable(q, for_sheet, layout)]
        pool = [q for q in pool if usable(q, for_sheet, layout)]
        by_type = {qt: [q for q in pool if q.qtype == qt] for qt in QTYPES}
        try:
            check_counts({qt: len(v) for qt, v in by_type.items()}, counts, for_sheet, layout)
        except MixError as e:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e))
        rng = random.Random()
        chosen = [q for qt in QTYPES for q in rng.sample(by_type[qt], counts.get(qt, 0))]
        if skipped:
            notes.append(f"Đã bỏ {len(skipped)} câu trắc nghiệm có hơn {layout.mcq_options} đáp án "
                         f"(phiếu chỉ có {'ABCDEFGH'[0]}–{'ABCDEFGH'[layout.mcq_options - 1]})")
        paper = self._save(name, "bank", {"category_ids": [c.id for c in cats],
                                          "category_names": [c.name for c in cats], "counts": counts,
                                          "for_sheet": for_sheet},
                           chosen, num_versions, start_code, shuffle_questions, shuffle_options, exam_id,
                           for_sheet, layout)
        return paper, notes

    def create_from_questions(self, *, name: str, questions: list[ParsedQuestion], file_name: str,
                              num_versions: int, start_code: str, shuffle_questions: bool,
                              shuffle_options: bool, exam_id: int | None,
                              counts: dict[str, int] | None = None,
                              for_sheet: bool = True,
                              source_docx: bytes | None = None,
                              sheet: object = None) -> tuple[ExamPaper, list[str]]:
        """Mix one uploaded đề. `counts` None → every usable question of the
        file; otherwise that many random questions per part (a file bigger
        than the sheet, e.g. a 131-câu Moodle export), kept in file order.
        source_docx: the one Word file the questions come from — the mã đề are
        then built from it, keeping formulas, pictures and formatting.
        A trắc nghiệm question with no answer (answer -1) can't be graded: left
        out when chấm bằng phiếu, kept with "?" in the đáp án for a đề chỉ để in."""
        notes: list[str] = []
        layout = self._layout(sheet) if for_sheet else None
        if for_sheet:
            unanswered = [q for q in questions if q.qtype == "mcq" and q.answer < 0]
            if unanswered:
                questions = [q for q in questions if not (q.qtype == "mcq" and q.answer < 0)]
                notes.append(f"{len(unanswered)} câu chưa có đáp án không được dùng (chấm bằng phiếu cần đáp án)")
        skipped = [q for q in questions if not usable(q, for_sheet, layout)]
        questions = [q for q in questions if usable(q, for_sheet, layout)]
        available = {qt: sum(1 for q in questions if q.qtype == qt) for qt in QTYPES}
        if counts is None:
            counts = available
        try:
            check_counts(available, counts, for_sheet, layout)
        except MixError as e:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e))
        if skipped:
            notes.append(f"Đã bỏ {len(skipped)} câu trắc nghiệm có hơn {layout.mcq_options} đáp án "
                         f"(phiếu chỉ có {'ABCDEFGH'[0]}–{'ABCDEFGH'[layout.mcq_options - 1]})")
        if counts != available:
            rng = random.Random()
            keep = {id(q) for qt in QTYPES
                    for q in rng.sample([q for q in questions if q.qtype == qt], counts.get(qt, 0))}
            questions = [q for q in questions if id(q) in keep]
            notes.append("Đã lấy ngẫu nhiên " + ", ".join(
                f"{counts.get(qt, 0)}/{available[qt]} câu Phần {PART_OF[qt]}" for qt in QTYPES if available[qt]))
        settings = {"file_name": file_name, "counts": counts, "for_sheet": for_sheet}
        stored = None
        if source_docx is not None:
            stored = f"{secrets.token_hex(16)}.docx"
            SOURCES_DIR.mkdir(parents=True, exist_ok=True)
            (SOURCES_DIR / stored).write_bytes(source_docx)
            settings.update(source_file=stored, keep_format=True)
        paper = self._save(name, "file", settings, questions, num_versions, start_code,
                           shuffle_questions, shuffle_options, exam_id, for_sheet, layout)
        if stored is not None:
            # Try one mã đề now: a file the format-keeping mixer can't handle
            # falls back to the plain Word output, and the teacher is told.
            first = paper.versions[0]
            try:
                from app.services.docx_mixer import version_docx_keep_format
                version_docx_keep_format(source_docx, first.code, plan_of(_snaps(first)))
                notes.insert(0, "Giữ nguyên định dạng Word của file gốc (công thức, hình ảnh, bảng)")
            except Exception:
                logger.exception("keep-format mixing failed for paper %s", paper.id)
                self._drop_source(paper)
                notes.insert(0, "Không giữ được định dạng của file này, đề được xuất dạng chữ (công thức, hình ảnh bị mất)")
        return paper, notes

    def _drop_source(self, p: ExamPaper) -> None:
        settings = json.loads(p.settings_json or "{}")
        path = source_path(settings)
        if path is not None and path.exists():
            path.unlink()
        settings.pop("source_file", None)
        settings["keep_format"] = False
        p.settings_json = json.dumps(settings, ensure_ascii=False)
        self.db.commit()

    def version_word(self, p: ExamPaper, code: str, snaps: list[Snapshot], subtitle: str) -> bytes:
        """The mã đề as Word: from the teacher's own file when the bộ đề keeps
        its format, else written from the question text."""
        settings = json.loads(p.settings_json or "{}")
        path = source_path(settings)
        if settings.get("keep_format") and path is not None and path.exists():
            try:
                from app.services.docx_mixer import version_docx_keep_format
                return version_docx_keep_format(path.read_bytes(), code, plan_of(snaps))
            except Exception:
                logger.exception("keep-format export failed for paper %s, falling back to text", p.id)
        return version_docx(p.name, code, snaps, subtitle,
                            assets=qa.load(self.db, qa.ids_in_questions(snaps)))

    # ── Update / delete ───────────────────────────────────────────────────
    def update(self, paper_id: int, fields: dict) -> ExamPaper:
        p = self.get_or_404(paper_id)
        if "name" in fields:
            if not (fields["name"] or "").strip():
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Nhập tên bộ đề")
            p.name = fields["name"].strip()
        if fields.get("sheet") is not None:
            # same mã đề, same questions: only the sheet they are graded on
            # changes, so it must hold every version (and be on a kỳ thi's
            # answer key under the new sheet's labels from now on)
            lay = self._layout(fields["sheet"])
            for v in p.versions:
                problem = sheet_problem(_snaps(v), v.code, lay)
                if problem:
                    raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                        f"Không chấm được bộ đề này bằng phiếu \"{lay.name}\" ({problem})")
            settings = json.loads(p.settings_json or "{}")
            settings["for_sheet"] = True
            if lay.id:
                settings["sheet"] = lay.id
            else:
                settings.pop("sheet", None)
            p.settings_json = json.dumps(settings, ensure_ascii=False)
        if "exam_id" in fields:
            if fields["exam_id"] is not None:
                self._exam_or_404(fields["exam_id"])
                lay = self.grading_layout(p)
                if lay is None:
                    raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                        "Phiếu trả lời của bộ đề này đã bị xóa, không gắn vào kỳ thi được")
                for v in p.versions:
                    self._check_gradable(_snaps(v), v.code, lay)
                self._check_codes_free(fields["exam_id"], p, [v.code for v in p.versions if v.in_exam])
            p.exam_id = fields["exam_id"]
        self.db.commit()
        self.db.refresh(p)
        return p

    def set_version_in_exam(self, paper_id: int, version_id: int, in_exam: bool) -> ExamPaper:
        p = self.get_or_404(paper_id)
        v = next((v for v in p.versions if v.id == version_id), None)
        if v is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy mã đề")
        if in_exam and p.exam_id is not None:
            self._check_codes_free(p.exam_id, p, [v.code])
        v.in_exam = in_exam
        self.db.commit()
        self.db.refresh(p)
        return p

    @staticmethod
    def _check_gradable(snaps: list[Snapshot], code: str, layout: SheetLayout | None = None) -> None:
        problem = sheet_problem(snaps, code, layout)
        if problem:
            where = f"phiếu \"{layout.name}\"" if layout else "phiếu Mẫu 40 câu trắc nghiệm"
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                f"Bộ đề này không chấm được bằng {where} ({problem}), chỉ dùng để in và "
                                "không gắn vào kỳ thi được")

    def _check_codes_free(self, exam_id: int, paper: ExamPaper, codes: list[str]) -> None:
        """Two bộ đề in the same kỳ thi can't both provide the same mã đề —
        grading couldn't tell which answer key a sheet belongs to."""
        taken = {
            v.code: other.name
            for other in self.db.query(ExamPaper).filter(ExamPaper.exam_id == exam_id, ExamPaper.id != paper.id)
            for v in other.versions if v.in_exam
        }
        clash = [c for c in codes if c in taken]
        if clash:
            raise HTTPException(status.HTTP_409_CONFLICT,
                                f"Mã đề {', '.join(clash)} đã có trong kỳ thi (bộ đề \"{taken[clash[0]]}\")")

    def delete(self, paper_id: int) -> None:
        p = self.get_or_404(paper_id)
        path = source_path(json.loads(p.settings_json or "{}"))
        if path is not None and path.exists():
            path.unlink()
        # SQLite doesn't enforce ON DELETE CASCADE — delete versions explicitly.
        self.db.query(ExamPaperVersion).filter(ExamPaperVersion.paper_id == p.id).delete()
        self.db.delete(p)
        self.db.commit()

    # ── For grading (step 6.2) ────────────────────────────────────────────
    def exam_answer_key(self, exam_id: int, sheet: object = None) -> dict:
        """Answer key of every mã đề attached to this kỳ thi, in the grading
        labels of the answer sheet each bộ đề was mixed for:
        {"byMaDe": {code: {label: value}}, "papers": [names], "versions": [codes],
        "sheets": [template ids], "sheetNames": {id: name}}. sheet = only the bộ đề mixed for that sheet
        (a Mẫu 40 bộ đề must not lock the đáp án of a Phiếu Bộ GD đợt chấm, and
        back). Empty byMaDe = nothing attached."""
        exam = self.db.get(Exam, exam_id)
        if not exam:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy kỳ thi")
        papers = self.db.query(ExamPaper).filter(ExamPaper.exam_id == exam_id).order_by(ExamPaper.id).all()
        papers = [p for p in papers if self._mine(p.owner_id)]
        want = None
        if sheet is not None:
            asked = get_layout(self.db, sheet)
            want = asked.id if asked else -1      # a sheet no bộ đề can be on
        by_ma_de: dict[str, dict[str, str]] = {}
        names, sheets, sheet_names = [], set(), {}
        for p in papers:
            lay = self.grading_layout(p)
            if lay is None or (want is not None and lay.id != want):
                continue
            used = [v for v in p.versions if v.in_exam and sheet_problem(_snaps(v), v.code, lay) is None]
            if used:
                names.append(p.name)
                sheets.add(lay.id)
                sheet_names[str(lay.id)] = lay.name
            for v in used:
                by_ma_de[v.code] = grading_key(_snaps(v), lay)
        # sheets: the answer sheet(s) those bộ đề were mixed for, so grading
        # can pick the matching template
        return {"byMaDe": by_ma_de, "papers": names, "versions": sorted(by_ma_de), "sheets": sorted(sheets),
                "sheetNames": sheet_names}
