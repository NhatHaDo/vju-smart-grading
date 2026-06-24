from datetime import datetime, timedelta, timezone
from typing import Any

from jose import JWTError, jwt

from app.config import get_settings

settings = get_settings()

ALGORITHM = "HS256"


def create_access_token(subject: int | str, extra: dict[str, Any] | None = None) -> str:
    """Create a signed JWT access token."""
    now     = datetime.now(timezone.utc)
    expire  = now + timedelta(minutes=settings.jwt_access_expire_minutes)
    payload = {
        "sub": str(subject),
        "iat": now,
        "exp": expire,
        **(extra or {}),
    }
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=ALGORITHM)


def decode_access_token(token: str) -> dict[str, Any]:
    """Decode and validate a JWT. Raises JWTError on failure."""
    return jwt.decode(token, settings.jwt_secret_key, algorithms=[ALGORITHM])


def get_subject(token: str) -> str:
    """Extract the 'sub' claim from a token. Raises JWTError on failure."""
    payload = decode_access_token(token)
    sub = payload.get("sub")
    if sub is None:
        raise JWTError("Token missing 'sub' claim")
    return str(sub)


# ── Refresh token ─────────────────────────────────────────────────────────────

def create_refresh_token(subject: int | str) -> str:
    """Create a long-lived signed JWT refresh token (type='refresh')."""
    now    = datetime.now(timezone.utc)
    expire = now + timedelta(days=settings.jwt_refresh_expire_days)
    payload = {
        "sub":  str(subject),
        "iat":  now,
        "exp":  expire,
        "type": "refresh",
    }
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=ALGORITHM)


def decode_refresh_token(token: str) -> dict[str, Any]:
    """Decode and validate a refresh token.
    Raises JWTError if invalid, expired, or not a refresh token."""
    payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[ALGORITHM])
    if payload.get("type") != "refresh":
        raise JWTError("Not a refresh token")
    sub = payload.get("sub")
    if sub is None:
        raise JWTError("Token missing 'sub' claim")
    return payload
