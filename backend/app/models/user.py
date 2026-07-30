from datetime import datetime, timezone
from enum import Enum as PyEnum

from sqlalchemy import Boolean, DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class UserRole(str, PyEnum):
    admin   = "admin"
    teacher = "teacher"
    viewer  = "viewer"


class User(Base):
    __tablename__ = "users"

    id:            Mapped[int]      = mapped_column(primary_key=True, index=True)
    email:         Mapped[str]      = mapped_column(String(255), unique=True, index=True, nullable=False)
    name:          Mapped[str]      = mapped_column(String(255), nullable=False, default="")
    # 2026-07-30: used to identify a teacher for the phone-based password-reset
    # flow (enter matching email + phone -> set a new password directly, no
    # OTP/email link — an explicit, deliberate product choice). Nullable so
    # existing accounts (e.g. the seeded admin) don't break.
    phone:         Mapped[str | None] = mapped_column(String(20), nullable=True)
    password_hash: Mapped[str]      = mapped_column(String(255), nullable=False)
    role:          Mapped[str]      = mapped_column(String(20), nullable=False, default=UserRole.teacher)
    is_active:     Mapped[bool]     = mapped_column(Boolean, nullable=False, default=True)
    created_at:    Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at:    Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    def __repr__(self) -> str:
        return f"<User id={self.id} email={self.email} role={self.role}>"
