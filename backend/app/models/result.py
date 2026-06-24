from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class GradingResult(Base):
    __tablename__ = "grading_results"

    id:               Mapped[int]        = mapped_column(primary_key=True, index=True)
    sheet_id:         Mapped[int]        = mapped_column(ForeignKey("sheets.id"), nullable=False, unique=True, index=True)
    exam_id:          Mapped[int]        = mapped_column(ForeignKey("exams.id"), nullable=False, index=True)
    student_id:       Mapped[str | None] = mapped_column(String(50), nullable=True)
    answers_json:     Mapped[str]        = mapped_column(Text, nullable=False, default="{}")   # {"toan1":"A",...}
    scores_json:      Mapped[str]        = mapped_column(Text, nullable=False, default="{}")   # {"toan1":1.0,...}
    section_json:     Mapped[str]        = mapped_column(Text, nullable=False, default="{}")   # {"Toán":8.0,...}
    total_score:      Mapped[float]      = mapped_column(Float, nullable=False, default=0.0)
    severity:         Mapped[str]        = mapped_column(String(10), nullable=False, default="ok")  # ok/low/medium/high
    needs_review:     Mapped[bool]       = mapped_column(nullable=False, default=False)
    empty_count:      Mapped[int]        = mapped_column(nullable=False, default=0)
    multi_mark_count: Mapped[int]        = mapped_column(nullable=False, default=0)
    graded_at:        Mapped[datetime]   = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    sheet = relationship("Sheet", back_populates="result")

    def __repr__(self) -> str:
        return f"<GradingResult id={self.id} sheet_id={self.sheet_id} total={self.total_score}>"
