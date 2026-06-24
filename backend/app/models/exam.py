from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class ExamStatus(str):
    DRAFT    = "draft"
    ACTIVE   = "active"
    CLOSED   = "closed"
    ARCHIVED = "archived"


class Exam(Base):
    __tablename__ = "exams"

    id:               Mapped[int]         = mapped_column(primary_key=True, index=True)
    name:             Mapped[str]         = mapped_column(String(255), nullable=False)
    subject:          Mapped[str]         = mapped_column(String(255), nullable=False, default="")
    exam_code:        Mapped[str | None]  = mapped_column(String(50),  nullable=True, unique=True, index=True)
    status:           Mapped[str]         = mapped_column(String(20),  nullable=False, default="draft")
    owner_id:         Mapped[int]         = mapped_column(ForeignKey("users.id"),      nullable=False)
    template_id:      Mapped[int | None]  = mapped_column(ForeignKey("templates.id"), nullable=True)
    total_students:   Mapped[int]         = mapped_column(Integer,     nullable=False, default=0)
    graded_count:     Mapped[int]         = mapped_column(Integer,     nullable=False, default=0)
    notes:            Mapped[str | None]  = mapped_column(Text,        nullable=True)
    exam_date:        Mapped[str | None]  = mapped_column(String(20),  nullable=True)   # ISO date YYYY-MM-DD
    # ── Extended wizard fields (added Phase 2) ──────────────────────────────
    subject_code:     Mapped[str | None]  = mapped_column(String(50),  nullable=True)
    semester:         Mapped[str | None]  = mapped_column(String(10),  nullable=True)   # I | II | III | HE
    academic_year:    Mapped[str | None]  = mapped_column(String(20),  nullable=True)   # e.g. 2025/2026
    lecturer_title:   Mapped[str | None]  = mapped_column(String(20),  nullable=True)
    lecturer_name:    Mapped[str | None]  = mapped_column(String(255), nullable=True)
    class_name:       Mapped[str | None]  = mapped_column(String(100), nullable=True)
    faculty:          Mapped[str | None]  = mapped_column(String(20),  nullable=True)   # FATE | SHSS
    training_program: Mapped[str | None]  = mapped_column(String(255), nullable=True)
    exam_time:        Mapped[str | None]  = mapped_column(String(10),  nullable=True)   # HH:MM
    room:             Mapped[str | None]  = mapped_column(String(100), nullable=True)
    shift:            Mapped[str | None]  = mapped_column(String(50),  nullable=True)
    created_at:       Mapped[datetime]    = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at:       Mapped[datetime]    = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    # Relationships (lazy-loaded to avoid circular imports)
    owner    = relationship("User",     foreign_keys=[owner_id],    lazy="select")
    template = relationship("Template", foreign_keys=[template_id], lazy="select")
    sheets   = relationship("Sheet",    back_populates="exam",      lazy="dynamic")

    def __repr__(self) -> str:
        return f"<Exam id={self.id} name={self.name!r} status={self.status}>"


class AnswerKey(Base):
    """Stores the correct answers + scoring config for an exam."""
    __tablename__ = "answer_keys"

    id:           Mapped[int]        = mapped_column(primary_key=True, index=True)
    exam_id:      Mapped[int]        = mapped_column(ForeignKey("exams.id"), nullable=False, unique=True, index=True)
    answers_json: Mapped[str]        = mapped_column(Text, nullable=False, default="{}")   # {"toan1":"A",...}
    scoring_json: Mapped[str]        = mapped_column(Text, nullable=False, default='{"correct":1.0,"wrong":-0.25,"unanswered":0.0}')
    created_at:   Mapped[datetime]   = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at:   Mapped[datetime]   = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    exam = relationship("Exam", foreign_keys=[exam_id], lazy="select")
