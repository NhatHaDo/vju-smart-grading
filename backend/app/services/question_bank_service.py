import json

from fastapi import HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.question_bank import Question, QuestionCategory, QuestionCategoryShare
from app.models.user import User
from app.services.question_io import ParsedQuestion

# Access levels, weakest → strongest. "owner" also covers admins.
_LEVELS = {"view": 1, "edit": 2, "owner": 3}


def question_to_dict(q: Question) -> dict:
    return {
        "id": q.id, "category_id": q.category_id, "qtype": q.qtype or "mcq", "content": q.content,
        "options": json.loads(q.options_json or "[]"), "answer": q.answer,
        "answer_text": q.answer_text, "shuffle_options": q.shuffle_options,
        "created_at": q.created_at, "updated_at": q.updated_at,
    }


def question_to_parsed(q: Question) -> ParsedQuestion:
    return ParsedQuestion(content=q.content, options=json.loads(q.options_json or "[]"),
                          answer=q.answer, shuffle_options=q.shuffle_options,
                          qtype=q.qtype or "mcq", answer_text=q.answer_text)


def _new_question(category_id: int, owner_id: int, p: ParsedQuestion) -> Question:
    return Question(category_id=category_id, owner_id=owner_id, qtype=p.qtype, content=p.content,
                    options_json=json.dumps(p.options, ensure_ascii=False), answer=p.answer,
                    answer_text=p.answer_text, shuffle_options=p.shuffle_options)


def _fingerprint(qtype: str, content: str, options: list[dict]) -> tuple:
    norm = lambda s: " ".join(s.split()).lower()   # noqa: E731
    return qtype or "mcq", norm(content), tuple(norm(o["text"]) for o in options)


class QuestionBankService:
    """Each teacher has a private bank. An owner can share a category with
    another account as "view" or "edit"; admins can access every category."""

    def __init__(self, db: Session, user: User) -> None:
        self.db   = db
        self.user = user

    # ── Access ────────────────────────────────────────────────────────────
    def access_level(self, c: QuestionCategory) -> str | None:
        if self.user.role == "admin" or c.owner_id == self.user.id:
            return "owner"
        share = (self.db.query(QuestionCategoryShare)
                 .filter(QuestionCategoryShare.category_id == c.id,
                         QuestionCategoryShare.user_id == self.user.id).first())
        return share.permission if share else None

    def get_category_or_404(self, category_id: int, need: str = "view") -> QuestionCategory:
        c = self.db.get(QuestionCategory, category_id)
        level = self.access_level(c) if c else None
        if level is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy danh mục")
        if _LEVELS[level] < _LEVELS[need]:
            detail = ("Chỉ chủ sở hữu mới làm được thao tác này" if need == "owner"
                      else "Danh mục được chia sẻ ở chế độ chỉ xem")
            raise HTTPException(status.HTTP_403_FORBIDDEN, detail)
        return c

    # ── Categories ────────────────────────────────────────────────────────
    def list_categories(self) -> list[dict]:
        type_counts: dict[int, dict[str, int]] = {}
        for cid, qtype, n in (self.db.query(Question.category_id, Question.qtype, func.count(Question.id))
                              .group_by(Question.category_id, Question.qtype)):
            type_counts.setdefault(cid, {})[qtype or "mcq"] = n
        unanswered = dict(self.db.query(Question.category_id, func.count(Question.id))
                          .filter(Question.qtype == "mcq", Question.answer < 0).group_by(Question.category_id))
        shared = {s.category_id: s.permission for s in
                  self.db.query(QuestionCategoryShare).filter(QuestionCategoryShare.user_id == self.user.id)}
        q = self.db.query(QuestionCategory)
        if self.user.role != "admin":
            q = q.filter((QuestionCategory.owner_id == self.user.id) | QuestionCategory.id.in_(list(shared)))
        cats = q.order_by(QuestionCategory.name).all()
        owners = {u.id: u for u in self.db.query(User).filter(User.id.in_({c.owner_id for c in cats}))}
        out = []
        for c in cats:
            level = "owner" if (self.user.role == "admin" or c.owner_id == self.user.id) else shared[c.id]
            out.append(self._category_dict(c, level, owners.get(c.owner_id), type_counts.get(c.id, {}),
                                           unanswered.get(c.id, 0)))
        # Own categories first, then those shared with me
        return sorted(out, key=lambda d: d["access"] != "owner")

    def _category_dict(self, c: QuestionCategory, access: str, owner: User | None = None,
                       type_counts: dict[str, int] | None = None, unanswered: int | None = None) -> dict:
        if unanswered is None:
            unanswered = (self.db.query(func.count(Question.id))
                          .filter(Question.category_id == c.id, Question.qtype == "mcq", Question.answer < 0).scalar())
        if type_counts is None:
            type_counts = {qt or "mcq": n for qt, n in
                           self.db.query(Question.qtype, func.count(Question.id))
                           .filter(Question.category_id == c.id).group_by(Question.qtype)}
        if owner is None:
            owner = self.db.get(User, c.owner_id)
        return {"id": c.id, "name": c.name, "description": c.description, "owner_id": c.owner_id,
                "owner_name": (owner.name or owner.email) if owner else "",
                "access": access, "question_count": sum(type_counts.values()),
                "type_counts": {qt: type_counts.get(qt, 0) for qt in ("mcq", "tf", "short")},
                "unanswered": unanswered or 0,
                "created_at": c.created_at, "updated_at": c.updated_at}

    def create_category(self, name: str, description: str | None) -> dict:
        c = QuestionCategory(name=name.strip(), description=description, owner_id=self.user.id)
        self.db.add(c)
        self.db.commit()
        self.db.refresh(c)
        return self._category_dict(c, "owner", self.user, {})

    def update_category(self, category_id: int, **fields) -> dict:
        c = self.get_category_or_404(category_id, need="owner")
        for k, v in fields.items():
            if v is not None:
                setattr(c, k, v.strip() if k == "name" else v)
        self.db.commit()
        self.db.refresh(c)
        return self._category_dict(c, "owner")

    def delete_category(self, category_id: int) -> None:
        c = self.get_category_or_404(category_id, need="owner")
        # SQLite doesn't enforce ON DELETE CASCADE here — delete children explicitly,
        # all in one transaction.
        self.db.query(Question).filter(Question.category_id == c.id).delete()
        self.db.query(QuestionCategoryShare).filter(QuestionCategoryShare.category_id == c.id).delete()
        self.db.delete(c)
        self.db.commit()

    def copy_category(self, category_id: int) -> dict:
        """Copy a (typically shared) category into my own bank."""
        src = self.get_category_or_404(category_id, need="view")
        dst = QuestionCategory(name=f"{src.name} (bản sao)", description=src.description, owner_id=self.user.id)
        self.db.add(dst)
        self.db.flush()
        questions = self.db.query(Question).filter(Question.category_id == src.id).order_by(Question.id).all()
        self.db.add_all(_new_question(dst.id, self.user.id, question_to_parsed(q)) for q in questions)
        self.db.commit()
        self.db.refresh(dst)
        return self._category_dict(dst, "owner", self.user)

    # ── Sharing (owner only) ──────────────────────────────────────────────
    def list_shares(self, category_id: int) -> list[dict]:
        c = self.get_category_or_404(category_id, need="owner")
        rows = (self.db.query(QuestionCategoryShare, User)
                .join(User, User.id == QuestionCategoryShare.user_id)
                .filter(QuestionCategoryShare.category_id == c.id)
                .order_by(User.email).all())
        return [{"id": s.id, "user_id": u.id, "email": u.email, "name": u.name,
                 "permission": s.permission, "created_at": s.created_at} for s, u in rows]

    def share(self, category_id: int, email: str, permission: str) -> list[dict]:
        c = self.get_category_or_404(category_id, need="owner")
        target = self.db.query(User).filter(func.lower(User.email) == email.strip().lower()).first()
        if not target or not target.is_active:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"Không tìm thấy tài khoản {email}")
        if target.id == c.owner_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Không thể chia sẻ cho chính chủ sở hữu")
        existing = (self.db.query(QuestionCategoryShare)
                    .filter(QuestionCategoryShare.category_id == c.id,
                            QuestionCategoryShare.user_id == target.id).first())
        if existing:
            existing.permission = permission
        else:
            self.db.add(QuestionCategoryShare(category_id=c.id, user_id=target.id, permission=permission))
        self.db.commit()
        return self.list_shares(category_id)

    def unshare(self, category_id: int, share_id: int) -> None:
        c = self.get_category_or_404(category_id, need="owner")
        s = self.db.get(QuestionCategoryShare, share_id)
        if not s or s.category_id != c.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy lượt chia sẻ")
        self.db.delete(s)
        self.db.commit()

    # ── Questions ─────────────────────────────────────────────────────────
    def list_questions(self, category_id: int, search: str | None = None,
                       qtype: str | None = None, unanswered: bool = False) -> list[Question]:
        c = self.get_category_or_404(category_id, need="view")
        q = self.db.query(Question).filter(Question.category_id == c.id)
        if qtype:
            q = q.filter(Question.qtype == qtype)
        if unanswered:
            q = q.filter(Question.qtype == "mcq", Question.answer < 0)
        if search:
            q = q.filter(Question.content.ilike(f"%{search.strip()}%"))
        return q.order_by(Question.id).all()

    def _question_for_edit(self, question_id: int) -> Question:
        q = self.db.get(Question, question_id)
        if not q:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy câu hỏi")
        self.get_category_or_404(q.category_id, need="edit")
        return q

    def create_question(self, category_id: int, data: dict) -> Question:
        c = self.get_category_or_404(category_id, need="edit")
        q = _new_question(c.id, c.owner_id, ParsedQuestion(**data))
        self.db.add(q)
        self.db.commit()
        self.db.refresh(q)
        return q

    def update_question(self, question_id: int, data: dict) -> Question:
        q = self._question_for_edit(question_id)
        q.qtype           = data["qtype"]
        q.content         = data["content"]
        q.options_json    = json.dumps(data["options"], ensure_ascii=False)
        q.answer          = data["answer"]
        q.answer_text     = data.get("answer_text")
        q.shuffle_options = data["shuffle_options"]
        self.db.commit()
        self.db.refresh(q)
        return q

    def set_answer(self, question_id: int, answer: int) -> Question:
        """Pick (or clear, -1) the correct option of a trắc nghiệm question —
        for questions imported without an answer marked."""
        q = self._question_for_edit(question_id)
        if (q.qtype or "mcq") != "mcq":
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Chỉ chọn đáp án cho câu trắc nghiệm")
        if not (answer == -1 or 0 <= answer < len(json.loads(q.options_json or "[]"))):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Đáp án đúng không hợp lệ")
        q.answer = answer
        self.db.commit()
        self.db.refresh(q)
        return q

    def delete_question(self, question_id: int) -> None:
        self.db.delete(self._question_for_edit(question_id))
        self.db.commit()

    # ── Import ────────────────────────────────────────────────────────────
    def import_questions(self, category_id: int, parsed: list[ParsedQuestion], dry_run: bool) -> dict:
        """Returns {new, duplicates, duplicate_list, answered, needs_answer}: new = added (or
        would be, when dry_run). Exact duplicates (same text and same options,
        ignoring case/whitespace) of a question already in the category — or
        earlier in the same file — are skipped; but a duplicate of a câu in
        the bank that still has no answer takes the answer given now
        (`answered`). `needs_answer` = indexes into `parsed` of the trắc
        nghiệm still without one that would land in the bank (new, or the
        bank's copy is unanswered) — what the page lets the teacher pick.
        `duplicate_list` says which câu were skipped and what they repeat.
        All-or-nothing: one commit."""
        c = self.get_category_or_404(category_id, need="edit")
        existing = {_fingerprint(q.qtype, q.content, json.loads(q.options_json or "[]")): q
                    for q in self.db.query(Question).filter(Question.category_id == c.id)}
        seen: dict = {}
        new, duplicates, fill, needs, dup_list = [], 0, [], [], []
        name = lambda p: f'{p.where or "Câu"} "{p.content[:60]}{"…" if len(p.content) > 60 else ""}"'
        for i, p in enumerate(parsed):
            fp = _fingerprint(p.qtype, p.content, p.options)
            if fp in seen:
                duplicates += 1
                dup_list.append(f"{name(p)}: trùng {seen[fp].where or 'một câu khác'} trong cùng file")
                continue
            seen[fp] = p
            old = existing.get(fp)
            open_mcq = p.qtype == "mcq"
            if old is None:
                new.append(p)
                if open_mcq and p.answer < 0:
                    needs.append(i)
                continue
            duplicates += 1
            dup_list.append(f"{name(p)}: đã có trong danh mục")
            if open_mcq and (old.answer is None or old.answer < 0):
                if p.answer >= 0:
                    fill.append((old, p.answer))
                else:
                    needs.append(i)
        if not dry_run:
            self.db.add_all(_new_question(c.id, c.owner_id, p) for p in new)
            for old, answer in fill:
                old.answer = answer
            self.db.commit()
        return {"new": len(new), "duplicates": duplicates, "duplicate_list": dup_list,
                "answered": len(fill), "needs_answer": needs}
