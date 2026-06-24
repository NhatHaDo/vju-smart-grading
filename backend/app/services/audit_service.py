from sqlalchemy.orm import Session

from app.repositories.audit_repository import AuditRepository


class AuditService:
    """Thin wrapper so routes don't import the repository directly."""

    def __init__(self, db: Session) -> None:
        self.repo = AuditRepository(db)

    def log(
        self,
        action: str,
        *,
        user_id: int | None = None,
        resource_type: str | None = None,
        resource_id: int | str | None = None,
        details: dict | None = None,
        ip_address: str | None = None,
    ) -> None:
        try:
            self.repo.log(
                action=action,
                user_id=user_id,
                resource_type=resource_type,
                resource_id=resource_id,
                details=details,
                ip_address=ip_address,
            )
        except Exception:
            # Audit logging must never break the main request
            pass
