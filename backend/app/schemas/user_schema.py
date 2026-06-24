from datetime import datetime

from pydantic import BaseModel, EmailStr, field_validator, ConfigDict


class UserBase(BaseModel):
    email: EmailStr
    name:  str = ""
    role:  str = "teacher"


class UserCreate(UserBase):
    password: str

    @field_validator("password")
    @classmethod
    def password_min_length(cls, v: str) -> str:
        if len(v) < 6:
            raise ValueError("Mật khẩu phải có ít nhất 6 ký tự")
        return v

    @field_validator("role")
    @classmethod
    def role_valid(cls, v: str) -> str:
        if v not in ("admin", "teacher", "viewer"):
            raise ValueError("Role phải là admin, teacher hoặc viewer")
        return v


class UserUpdate(BaseModel):
    name:      str | None = None
    role:      str | None = None
    is_active: bool | None = None


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id:         int
    email:      str
    name:       str
    role:       str
    is_active:  bool
    created_at: datetime

    # NOTE: password_hash is NEVER included here


class UserWithToken(BaseModel):
    user:          UserOut
    access_token:  str
    refresh_token: str
    token_type:    str = "bearer"
    expires_in:    int
