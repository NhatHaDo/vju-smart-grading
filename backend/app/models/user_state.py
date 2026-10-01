"""
Per-user saved app state (2026-09-28).

"a lưu đáp án xong đăng xuất ra vào lại thấy mất hết" — AnswerKeyPage kept
answer keys (active key, per-template drafts, saved library) ONLY in browser
localStorage, and logout deliberately wipes those keys (providers.tsx, so a
shared computer doesn't leak one teacher's answers to the next). Result: every
answer key was lost on logout.

This table is the server-side copy: one row per (user, key), value = the same
JSON the frontend keeps in localStorage. The frontend restores it after login
and writes through on every save (services/userStateSync.ts), so all the
existing pages keep reading localStorage synchronously, unchanged.
"""
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class UserState(Base):
    __tablename__ = "user_states"
    __table_args__ = (UniqueConstraint("user_id", "key", name="uq_user_states_user_key"),)

    id:         Mapped[int]      = mapped_column(primary_key=True)
    user_id:    Mapped[int]      = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    key:        Mapped[str]      = mapped_column(String(64), nullable=False)
    value_json: Mapped[str]      = mapped_column(Text, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
