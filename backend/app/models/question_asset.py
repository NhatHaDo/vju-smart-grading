"""
Công thức / hình ảnh của câu hỏi (2026-10-01) — see services/rich_objects.py.

A question's text refers to one as "[[ct:<id>]]"; the id is a hash of the
object's content, so the same formula imported twice is one row. Kept: the
Word XML and the parts it points at (MathType .bin + preview, image…) to put
the real object back into Word files, and an SVG for the web (None when the
server has no LibreOffice to draw it).

New table → Base.metadata.create_all() creates it on the next restart.
"""
from datetime import datetime

from sqlalchemy import DateTime, Float, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class QuestionAsset(Base):
    __tablename__ = "question_assets"

    id:         Mapped[str]          = mapped_column(String(40), primary_key=True)
    kind:       Mapped[str]          = mapped_column(String(10), nullable=False)   # object | drawing | pict | omath
    xml:        Mapped[str]          = mapped_column(Text, nullable=False)
    parts_json: Mapped[str]          = mapped_column(Text, nullable=False, default="{}")
    w_pt:       Mapped[float]        = mapped_column(Float, nullable=False, default=0)
    h_pt:       Mapped[float]        = mapped_column(Float, nullable=False, default=0)
    svg:        Mapped[str | None]   = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime]     = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
