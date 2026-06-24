from pydantic import BaseModel, EmailStr, field_validator


class LoginRequest(BaseModel):
    email:    EmailStr
    password: str


class RegisterRequest(BaseModel):
    email:    EmailStr
    password: str
    name:     str = ""

    @field_validator("password")
    @classmethod
    def password_min_length(cls, v: str) -> str:
        if len(v) < 6:
            raise ValueError("Mật khẩu phải có ít nhất 6 ký tự")
        return v


class TokenResponse(BaseModel):
    access_token:  str
    token_type:    str = "bearer"
    expires_in:    int           # seconds


class RefreshRequest(BaseModel):
    refresh_token: str


class RefreshResponse(BaseModel):
    access_token:  str
    refresh_token: str            # rotated on each use
    token_type:    str = "bearer"
    expires_in:    int            # seconds (access token lifetime)
