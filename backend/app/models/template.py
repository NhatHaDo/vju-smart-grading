from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Template(Base):
    __tablename__ = "templates"

    id:             Mapped[int]        = mapped_column(primary_key=True, index=True)
    name:           Mapped[str]        = mapped_column(String(255), nullable=False)
    type:           Mapped[str]        = mapped_column(String(50), nullable=False, default="vju_sbd8")
    version:        Mapped[str]        = mapped_column(String(20), nullable=False, default="1.0")
    file_path:      Mapped[str | None] = mapped_column(String(512), nullable=True)   # path to compiled .json
    description:    Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active:      Mapped[bool]       = mapped_column(Boolean, nullable=False, default=True)

    # ── Custom template fields (nullable — system templates leave these NULL) ──
    areas_path:     Mapped[str | None] = mapped_column(String(512), nullable=True)   # path to .areas.json
    page_width:     Mapped[int | None] = mapped_column(Integer, nullable=True)        # pageDimensions[0]
    page_height:    Mapped[int | None] = mapped_column(Integer, nullable=True)        # pageDimensions[1]
    owner_user_id:  Mapped[int | None] = mapped_column(Integer, nullable=True)        # FK users.id (soft)
    is_default:     Mapped[bool]       = mapped_column(Boolean, nullable=False, default=False)

    created_at:     Mapped[datetime]   = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at:     Mapped[datetime]   = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    def __repr__(self) -> str:
        return f"<Template id={self.id} name={self.name!r} type={self.type}>"
