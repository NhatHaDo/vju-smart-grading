from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.core.security.permissions import get_current_user
from app.database import get_db
from app.models.user import User
from app.schemas.auth_schema import LoginRequest, RegisterRequest, RefreshRequest, RefreshResponse
from app.schemas.user_schema import UserOut, UserWithToken
from app.services.audit_service import AuditService
from app.services.auth_service import AuthService

router = APIRouter(prefix="/auth", tags=["auth"])


def _ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


@router.post("/register", response_model=UserOut, status_code=201)
def register(body: RegisterRequest, request: Request, db: Session = Depends(get_db)):
    svc   = AuthService(db)
    audit = AuditService(db)
    user  = svc.register(email=body.email, password=body.password, name=body.name)
    audit.log("register", user_id=user.id, resource_type="user", resource_id=user.id, ip_address=_ip(request))
    return user


@router.post("/login", response_model=UserWithToken)
def login(body: LoginRequest, request: Request, db: Session = Depends(get_db)):
    svc    = AuthService(db)
    audit  = AuditService(db)
    result = svc.login(email=body.email, password=body.password)
    audit.log("login", user_id=result.user.id, resource_type="user", resource_id=result.user.id, ip_address=_ip(request))
    return result


@router.post("/refresh", response_model=RefreshResponse)
def refresh_token(body: RefreshRequest, db: Session = Depends(get_db)):
    """Exchange a valid refresh token for a new access + refresh token pair."""
    svc = AuthService(db)
    return svc.refresh(body.refresh_token)


@router.get("/me", response_model=UserOut)
def me(current_user: User = Depends(get_current_user)):
    return current_user
