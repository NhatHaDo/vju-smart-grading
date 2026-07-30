from pydantic import BaseModel, EmailStr, field_validator


class LoginRequest(BaseModel):
    email:    EmailStr
    password: str


class RegisterRequest(BaseModel):
    email:    EmailStr
    password: str
    phone:    str
    name:     str = ""

    # 2026-07-30: teacher self-registration — "cần cho Giảng viên đăng kí tài
    # khoản với user là gmail... gmail phải có dạng @vju.ac.vn". Usable
    # immediately after registering (no admin approval step, per explicit
    # product choice) — AuthService.register already does that for every
    # self-registered account.
    @field_validator("email")
    @classmethod
    def email_must_be_vju(cls, v: str) -> str:
        if not v.lower().endswith("@vju.ac.vn"):
            raise ValueError("Email đăng ký phải có dạng @vju.ac.vn")
        return v

    @field_validator("password")
    @classmethod
    def password_min_length(cls, v: str) -> str:
        if len(v) < 6:
            raise ValueError("Mật khẩu phải có ít nhất 6 ký tự")
        return v

    @field_validator("phone")
    @classmethod
    def phone_valid(cls, v: str) -> str:
        digits = v.strip().replace(" ", "")
        if len(digits) < 9 or not digits.lstrip("+").isdigit():
            raise ValueError("Số điện thoại không hợp lệ")
        return digits


class ForgotPasswordRequest(BaseModel):
    """Reset-by-match: entering the account's own email + phone number is
    treated as proof of ownership and immediately allows setting a new
    password — no OTP/email-link step, per explicit product choice."""
    email:        EmailStr
    phone:        str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def new_password_min_length(cls, v: str) -> str:
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
