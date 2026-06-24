import json

from sqlalchemy.orm import Session

from app.models.audit_log import AuditLog


class AuditRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def log(
        self,
        action: str,
        *,
        user_id: int | None = None,
        resource_type: str | None = None,
        resource_id: str | None = None,
        details: dict | None = None,
        ip_address: str | None = None,
    ) -> AuditLog:
        entry = AuditLog(
            action=action,
            user_id=user_id,
            resource_type=resource_type,
            resource_id=str(resource_id) if resource_id is not None else None,
            details_json=json.dumps(details, ensure_ascii=False) if details else None,
            ip_address=ip_address,
        )
        self.db.add(entry)
        self.db.commit()
        return entry

    def list_by_user(self, user_id: int, limit: int = 100) -> list[AuditLog]:
        return (
            self.db.query(AuditLog)
            .filter(AuditLog.user_id == user_id)
            .order_by(AuditLog.created_at.desc())
            .limit(limit)
            .all()
        )

    def list_recent(self, limit: int = 200) -> list[AuditLog]:
        return (
            self.db.query(AuditLog)
            .order_by(AuditLog.created_at.desc())
            .limit(limit)
            .all()
        )
