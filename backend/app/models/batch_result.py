"""
batch_result.py
===============
Stores OMR batch results submitted by the frontend after /omr/debug-grade.

Why a separate table instead of extending GradingResult
--------------------------------------------------------
GradingResult requires sheet_id + exam_id (NOT NULL) because it is tied to
the full exam management flow (sheet upload → exam grading → DB).
The debug-grade batch flow runs without a DB-backed sheet or exam, so those
FKs would always be NULL — which SQLite can't add to existing NOT NULL columns
without a full table rebuild.

BatchResult keeps the existing GradingResult table completely intact and adds
a new table for frontend-submitted batch results.  All foreign keys here are
soft (stored as plain INTEGER, no FK constraint) so we can safely store NULL.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Float, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class BatchResult(Base):
    __tablename__ = "batch_results"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)

    # ── Optional context (all nullable — batch may have no exam/sheet) ───────
    exam_id:   Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    sheet_id:  Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)

    # ── Template provenance ───────────────────────────────────────────────────
    template_type:    Mapped[str | None] = mapped_column(String(20),  nullable=True)  # sbd4/sbd8/custom
    template_variant: Mapped[str | None] = mapped_column(String(50),  nullable=True)
    template_id:      Mapped[int | None] = mapped_column(Integer,     nullable=True)  # soft ref, no FK

    # ── Original file ─────────────────────────────────────────────────────────
    file_name: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # ── Student info ──────────────────────────────────────────────────────────
    cccd:    Mapped[str | None] = mapped_column(String(20),  nullable=True)
    sbd:     Mapped[str | None] = mapped_column(String(10),  nullable=True)
    ma_de:   Mapped[str | None] = mapped_column(String(10),  nullable=True)
    ca_thi:  Mapped[str | None] = mapped_column(String(50),  nullable=True)
    ma_ctdt: Mapped[str | None] = mapped_column(String(50),  nullable=True)
    tu_chon: Mapped[str | None] = mapped_column(String(10),  nullable=True)

    # ── Grading result (JSON-serialised) ─────────────────────────────────────
    answers_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    scores_json:  Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    section_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    total_score:  Mapped[float] = mapped_column(Float, nullable=False, default=0.0)

    # ── Status ────────────────────────────────────────────────────────────────
    severity:        Mapped[str]  = mapped_column(String(10), nullable=False, default="ok")
    needs_review:    Mapped[bool] = mapped_column(nullable=False, default=False)
    empty_count:     Mapped[int]  = mapped_column(nullable=False, default=0)
    multi_mark_count:Mapped[int]  = mapped_column(nullable=False, default=0)

    # ── Extended JSON blobs ───────────────────────────────────────────────────
    warnings_json:           Mapped[str | None] = mapped_column(Text, nullable=True)
    info_field_columns_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    debug_paths_json:        Mapped[str | None] = mapped_column(Text, nullable=True)

    # ── Manual corrections ────────────────────────────────────────────────────
    manual_corrections_json: Mapped[str | None] = mapped_column(Text, nullable=True)

    # ── Timestamps ────────────────────────────────────────────────────────────
    graded_at:    Mapped[datetime]       = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    corrected_at: Mapped[datetime | None]= mapped_column(DateTime(timezone=True), nullable=True)

    def __repr__(self) -> str:
        return f"<BatchResult id={self.id} file={self.file_name!r} score={self.total_score}>"
