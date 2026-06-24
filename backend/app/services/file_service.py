"""
Secure file upload service.

Security rules (enforced here, NOT in the route):
  - Only allowed MIME types / extensions.
  - Max file size from config.
  - Filename is always replaced with a UUID — original name stored for display only.
  - Files saved under config.omr_upload_dir (never directly under the web root).
"""
import uuid
from pathlib import Path

from fastapi import HTTPException, UploadFile, status

from app.config import get_settings

settings = get_settings()

ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".pdf"}
ALLOWED_MIME_TYPES = {
    "image/jpeg",
    "image/png",
    "application/pdf",
}
MAX_UPLOAD_BYTES = 20 * 1024 * 1024   # 20 MB


def _upload_dir() -> Path:
    p = Path(settings.omr_upload_dir)
    p.mkdir(parents=True, exist_ok=True)
    return p


def validate_upload(file: UploadFile, max_bytes: int = MAX_UPLOAD_BYTES) -> None:
    """Raise HTTPException if the file is not acceptable."""
    # Extension check
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"Chỉ chấp nhận: {', '.join(sorted(ALLOWED_EXTENSIONS))}",
        )
    # MIME type check
    if file.content_type and file.content_type not in ALLOWED_MIME_TYPES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"Content-Type không hợp lệ: {file.content_type}",
        )


async def save_upload(file: UploadFile) -> tuple[str, int, str]:
    """
    Validate, read, and save the file with a UUID name.

    Returns (safe_file_path: str, file_size: int, original_filename: str)
    """
    validate_upload(file)

    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File quá lớn. Tối đa {MAX_UPLOAD_BYTES // (1024*1024)} MB",
        )

    suffix       = Path(file.filename or "file.jpg").suffix.lower()
    safe_name    = f"{uuid.uuid4().hex}{suffix}"
    dest         = _upload_dir() / safe_name
    dest.write_bytes(data)

    return str(dest), len(data), file.filename or safe_name
