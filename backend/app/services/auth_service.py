from fastapi import HTTPException, status
from jose import JWTError
from sqlalchemy.orm import Session

from app.config import get_settings
from app.core.security.jwt import (
    create_access_token,
    create_refresh_token,
    decode_refresh_token,
)
from app.core.security.password import hash_password, verify_password
from app.models.user import User
from app.repositories.user_repository import UserRepository
from app.schemas.auth_schema import RefreshResponse
from app.schemas.user_schema import UserOut, UserWithToken

settings = get_settings()


class AuthService:
    def __init__(self, db: Session) -> None:
        self.repo = UserRepository(db)

    def register(self, email: str, password: str, name: str = "", phone: str | None = None) -> User:
        if self.repo.get_by_email(email):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Email này đã được đăng ký",
            )
        hashed = hash_password(password)
        # First user ever → admin; subsequent → teacher
        role = "admin" if self.repo.count() == 0 else "teacher"
        return self.repo.create(email=email, name=name, password_hash=hashed, role=role, phone=phone)

    def reset_password(self, email: str, phone: str, new_password: str) -> User:
        """Reset-by-match: no OTP/email link — matching email + phone is
        treated as sufficient proof of ownership, per explicit product
        choice ("chỉ cần nhập đúng gmail và sđt là cho người ta đặt mật
        khẩu mới"). Deliberately less secure than a verification-code flow;
        this trade-off was chosen knowingly, not an oversight."""
        user = self.repo.get_by_email_and_phone(email, phone)
        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Không tìm thấy tài khoản khớp với email và số điện thoại này",
            )
        return self.repo.update(user, password_hash=hash_password(new_password))

    def login(self, email: str, password: str) -> UserWithToken:
        user = self.repo.get_by_email(email)
        if not user or not verify_password(password, user.password_hash):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Email hoặc mật khẩu không đúng",
            )
        if not user.is_active:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Tài khoản đã bị vô hiệu hoá",
            )
        access  = create_access_token(user.id, extra={"role": user.role})
        refresh = create_refresh_token(user.id)
        expires_in = settings.jwt_access_expire_minutes * 60
        return UserWithToken(
            user=UserOut.model_validate(user),
            access_token=access,
            refresh_token=refresh,
            expires_in=expires_in,
        )

    def refresh(self, refresh_token: str) -> RefreshResponse:
        """Issue new access + refresh tokens given a valid refresh token."""
        try:
            payload = decode_refresh_token(refresh_token)
        except JWTError:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Refresh token expired",
            )

        try:
            user_id = int(payload["sub"])
        except (KeyError, ValueError):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Refresh token invalid",
            )

        user = self.repo.get_by_id(user_id)
        if not user or not user.is_active:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="User not found or inactive",
            )

        new_access  = create_access_token(user_id, extra={"role": user.role})
        new_refresh = create_refresh_token(user_id)   # rotate every use
        expires_in  = settings.jwt_access_expire_minutes * 60

        return RefreshResponse(
            access_token=new_access,
            refresh_token=new_refresh,
            expires_in=expires_in,
        )
