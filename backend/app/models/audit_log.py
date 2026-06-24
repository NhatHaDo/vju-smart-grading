from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id:            Mapped[int]        = mapped_column(primary_key=True, index=True)
    user_id:       Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    action:        Mapped[str]        = mapped_column(String(100), nullable=False, index=True)
    resource_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    resource_id:   Mapped[str | None] = mapped_column(String(100), nullable=True)
    details_json:  Mapped[str | None] = mapped_column(Text, nullable=True)    # JSON blob
    ip_address:    Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at:    Mapped[datetime]   = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), index=True
    )

    def __repr__(self) -> str:
        return f"<AuditLog id={self.id} action={self.action} user_id={self.user_id}>"
