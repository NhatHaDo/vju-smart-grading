"""
FastAPI dependencies for authentication and role-based access control.

Usage:
    from app.core.security.permissions import get_current_user, require_roles

    @router.get("/admin-only")
    def admin_route(user: User = Depends(require_roles("admin"))):
        ...
"""
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError
from sqlalchemy.orm import Session

from app.core.security.jwt import get_subject
from app.database import get_db
from app.models.user import User

_bearer = HTTPBearer(auto_error=True)


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    """Dependency: validate JWT and return the authenticated User."""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Không thể xác thực token",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        user_id = get_subject(credentials.credentials)
    except JWTError:
        raise credentials_exception

    user = db.get(User, int(user_id))
    if user is None or not user.is_active:
        raise credentials_exception
    return user


def require_roles(*roles: str):
    """Dependency factory: require the current user to have one of *roles*."""
    def _check(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Bạn cần có quyền: {', '.join(roles)}",
            )
        return user
    return _check


# Convenience shortcuts
require_admin   = require_roles("admin")
require_teacher = require_roles("admin", "teacher")
