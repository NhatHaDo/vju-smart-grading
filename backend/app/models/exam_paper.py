"""
Bộ đề trộn (2026-09-29) — step 4-5 of the workflow: a set of shuffled exam
versions (mã đề 101, 102, …) built from the question bank or from one
uploaded đề file, optionally attached to a kỳ thi so grading can fill the
answer key per mã đề automatically (step 6.2).

Each version stores a SNAPSHOT of its questions (text, shuffled options,
correct answer) — not references into the bank — so editing or deleting a
bank question later never changes an exam that was already printed.

New tables only → created by Base.metadata.create_all() on startup.
"""
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class ExamPaper(Base):
    __tablename__ = "exam_papers"

    id:            Mapped[int]        = mapped_column(primary_key=True, index=True)
    owner_id:      Mapped[int]        = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    name:          Mapped[str]        = mapped_column(String(255), nullable=False)
    # Kỳ thi this set is used for (step 5); null = not attached yet.
    exam_id:       Mapped[int | None] = mapped_column(ForeignKey("exams.id"), nullable=True, index=True)
    source:        Mapped[str]        = mapped_column(String(10), nullable=False, default="bank")   # "bank" | "file"
    # How it was built: categories, counts per part, shuffle flags, seed…
    settings_json: Mapped[str]        = mapped_column(Text, nullable=False, default="{}")
    created_at:    Mapped[datetime]   = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at:    Mapped[datetime]   = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    versions = relationship(
        "ExamPaperVersion", back_populates="paper", lazy="select",
        cascade="all, delete-orphan", order_by="ExamPaperVersion.id",
    )


class ExamPaperVersion(Base):
    """One mã đề. questions_json = ordered list, trắc nghiệm then Đúng/Sai then trả lời ngắn:
    [{"qtype", "content", "options": [{"text", "correct"?}], "answer", "answer_text"}]
    with options already in this version's shuffled order."""
    __tablename__ = "exam_paper_versions"
    __table_args__ = (UniqueConstraint("paper_id", "code", name="uq_exam_paper_versions_code"),)

    id:             Mapped[int]      = mapped_column(primary_key=True, index=True)
    paper_id:       Mapped[int]      = mapped_column(ForeignKey("exam_papers.id", ondelete="CASCADE"), nullable=False, index=True)
    code:           Mapped[str]      = mapped_column(String(10), nullable=False)
    questions_json: Mapped[str]      = mapped_column(Text, nullable=False, default="[]")
    # Step 5 — "Thêm/Xóa đề vào kỳ thi": only versions with in_exam=True are
    # used for the kỳ thi's answer key.
    in_exam:        Mapped[bool]     = mapped_column(Boolean, nullable=False, default=True)
    created_at:     Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    paper = relationship("ExamPaper", back_populates="versions", lazy="select")
