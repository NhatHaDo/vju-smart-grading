from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class SheetStatus(str):
    PENDING      = "pending"
    PROCESSING   = "processing"
    GRADED       = "graded"
    NEEDS_REVIEW = "needs_review"
    ERROR        = "error"


class Sheet(Base):
    __tablename__ = "sheets"

    id:                Mapped[int]        = mapped_column(primary_key=True, index=True)
    exam_id:           Mapped[int]        = mapped_column(ForeignKey("exams.id"), nullable=False, index=True)
    student_id:        Mapped[str | None] = mapped_column(String(50), nullable=True)   # SBD from OMR
    student_name:      Mapped[str | None] = mapped_column(String(255), nullable=True)
    original_filename: Mapped[str | None] = mapped_column(String(512), nullable=True)  # original upload name (for display)
    file_path:         Mapped[str]        = mapped_column(String(512), nullable=False)  # UUID-renamed, safe path
    file_size:         Mapped[int]        = mapped_column(nullable=False, default=0)    # bytes
    mime_type:         Mapped[str | None] = mapped_column(String(100), nullable=True)
    status:            Mapped[str]        = mapped_column(String(20), nullable=False, default=SheetStatus.PENDING)
    needs_review:      Mapped[bool]       = mapped_column(Boolean, nullable=False, default=False)
    alignment_warning: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_message:     Mapped[str | None] = mapped_column(Text, nullable=True)
    uploaded_by:       Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at:        Mapped[datetime]   = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at:        Mapped[datetime]   = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    exam   = relationship("Exam", back_populates="sheets", foreign_keys=[exam_id])
    result = relationship("GradingResult", back_populates="sheet", uselist=False, lazy="select")

    def __repr__(self) -> str:
        return f"<Sheet id={self.id} exam_id={self.exam_id} status={self.status}>"
