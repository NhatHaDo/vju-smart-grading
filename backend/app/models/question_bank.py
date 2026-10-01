"""
Ngân hàng câu hỏi (2026-09-28) — step 1-2 of the "trộn đề" workflow:
teachers keep categorised multiple-choice questions here, import/export them
as Aiken .txt (Moodle export format) or Word .docx (YoungMix-style), and
later shuffle exam versions (mã đề) out of them.

New tables only → Base.metadata.create_all() in init_db() creates them on the
next server restart; no ALTER migration needed.
"""
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class QuestionCategory(Base):
    __tablename__ = "question_categories"

    id:          Mapped[int]        = mapped_column(primary_key=True, index=True)
    name:        Mapped[str]        = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    owner_id:    Mapped[int]        = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    created_at:  Mapped[datetime]   = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at:  Mapped[datetime]   = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    questions = relationship(
        "Question", back_populates="category", lazy="dynamic",
        cascade="all, delete-orphan",
    )


class Question(Base):
    """One question, of one of the three kinds on the answer sheet
    ("Mẫu 40 câu TN + Đúng/Sai" — the 2025 exam format):

    qtype "mcq"   — trắc nghiệm (Phần I-II on the VJU sheet). options_json = [{"text", "fixed"}]
                    in A/B/C/D… order; answer = index of the correct one
                    (0 = A). `fixed` = YoungMix's "#A." marker: that option
                    keeps its position when options are shuffled.
    qtype "tf"    — Đúng/Sai (Phần III): 4 statements a) b) c) d).
                    options_json = [{"text", "fixed", "correct": bool}];
                    `answer` is unused.
    qtype "short" — trả lời ngắn (Phần IV): answer_text is the number as
                    bubbled on the sheet (max 4 chars, e.g. "-1,5", "2025");
                    options_json = [].

    shuffle_options: False for questions whose options must never be
    shuffled at all (e.g. a True/False mcq).
    """
    __tablename__ = "questions"

    id:              Mapped[int]      = mapped_column(primary_key=True, index=True)
    category_id:     Mapped[int]      = mapped_column(ForeignKey("question_categories.id", ondelete="CASCADE"), nullable=False, index=True)
    owner_id:        Mapped[int]      = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    content:         Mapped[str]      = mapped_column(Text, nullable=False)
    qtype:           Mapped[str]      = mapped_column(String(10), nullable=False, default="mcq", server_default="mcq")
    options_json:    Mapped[str]      = mapped_column(Text, nullable=False, default="[]")
    answer:          Mapped[int]      = mapped_column(Integer, nullable=False, default=0)
    answer_text:     Mapped[str | None] = mapped_column(String(10), nullable=True)
    shuffle_options: Mapped[bool]     = mapped_column(Boolean, nullable=False, default=True)
    created_at:      Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at:      Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    category = relationship("QuestionCategory", back_populates="questions", lazy="select")


class QuestionCategoryShare(Base):
    """A category shared by its owner with another account.
    permission: "view" (see / export / copy / use for trộn đề) or
                "edit" (also add / edit / delete / import questions).
    Renaming, deleting and sharing stay owner-only."""
    __tablename__ = "question_category_shares"
    __table_args__ = (UniqueConstraint("category_id", "user_id", name="uq_question_category_shares"),)

    id:          Mapped[int]      = mapped_column(primary_key=True)
    category_id: Mapped[int]      = mapped_column(ForeignKey("question_categories.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id:     Mapped[int]      = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    permission:  Mapped[str]      = mapped_column(String(10), nullable=False, default="view")
    created_at:  Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
