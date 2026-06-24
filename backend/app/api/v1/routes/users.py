from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.security.permissions import get_current_user, require_roles
from app.database import get_db
from app.models.user import User
from app.schemas.user_schema import UserCreate, UserOut, UserUpdate
from app.services.user_service import UserService

router = APIRouter(prefix="/users", tags=["users"])


@router.get("", response_model=list[UserOut])
def list_users(
    skip: int = 0,
    limit: int = 100,
    db: Session = Depends(get_db),
    _: User = Depends(require_roles("admin")),
):
    return UserService(db).list_users(skip=skip, limit=limit)


@router.post("", response_model=UserOut, status_code=201)
def create_user(
    body: UserCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_roles("admin")),
):
    return UserService(db).create_user(
        email=body.email, password=body.password, name=body.name, role=body.role
    )


@router.get("/me", response_model=UserOut)
def get_me(current_user: User = Depends(get_current_user)):
    return current_user


@router.get("/{user_id}", response_model=UserOut)
def get_user(
    user_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_roles("admin")),
):
    return UserService(db).get_or_404(user_id)


@router.put("/{user_id}", response_model=UserOut)
def update_user(
    user_id: int,
    body: UserUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_roles("admin")),
):
    svc = UserService(db)
    return svc.update_user(user_id, **body.model_dump(exclude_none=True))


@router.delete("/{user_id}", status_code=204)
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_roles("admin")),
):
    UserService(db).delete_user(user_id)
