from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.security.password import hash_password
from app.models.user import User
from app.repositories.user_repository import UserRepository


class UserService:
    def __init__(self, db: Session) -> None:
        self.repo = UserRepository(db)

    def get_or_404(self, user_id: int) -> User:
        user = self.repo.get_by_id(user_id)
        if not user:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Không tìm thấy người dùng")
        return user

    def list_users(self, skip: int = 0, limit: int = 100) -> list[User]:
        return self.repo.list_all(skip=skip, limit=limit)

    def create_user(self, email: str, password: str, name: str = "", role: str = "teacher") -> User:
        if self.repo.get_by_email(email):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email đã tồn tại")
        return self.repo.create(
            email=email,
            name=name,
            password_hash=hash_password(password),
            role=role,
        )

    def update_user(self, user_id: int, **kwargs) -> User:
        user = self.get_or_404(user_id)
        if "password" in kwargs:
            kwargs["password_hash"] = hash_password(kwargs.pop("password"))
        return self.repo.update(user, **kwargs)

    def delete_user(self, user_id: int) -> None:
        user = self.get_or_404(user_id)
        self.repo.delete(user)
