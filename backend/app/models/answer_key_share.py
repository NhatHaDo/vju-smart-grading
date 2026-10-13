"""
Đáp án behind a mã QR made from an Excel file (2026-10-13) — like
qrda.chamthi.com: the teacher uploads the answer file, the server keeps a copy
here and the QR only points to this row ("VJUAK2:<id>.<sig>", see
services/answer_qr.py), so the QR stays small enough to scan from a photo.

store_json = the frontend's AnswerKeyStore (answers / byMaDe / scoring), in
the labels of the answer sheet it was made for (template_mode / template_id).

New table only → created by Base.metadata.create_all() on startup.
"""
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class AnswerKeyShare(Base):
    __tablename__ = "answer_key_shares"

    id:            Mapped[int]        = mapped_column(primary_key=True, index=True)
    owner_id:      Mapped[int]        = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    name:          Mapped[str]        = mapped_column(String(255), nullable=False)
    template_mode: Mapped[str]        = mapped_column(String(10), nullable=False, default="custom")   # "vju" | "custom"
    template_id:   Mapped[int | None] = mapped_column(Integer, nullable=True)
    template_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    variant:       Mapped[str | None] = mapped_column(String(10), nullable=True)                       # VJU sbd4 / sbd8
    store_json:    Mapped[str]        = mapped_column(Text, nullable=False)
    created_at:    Mapped[datetime]   = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
