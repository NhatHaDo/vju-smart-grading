"""
/me/state — server-side copy of the logged-in user's answer keys (see
app/models/user_state.py for why). Only a fixed whitelist of keys is
accepted, each capped in size, so this can't become arbitrary storage.
"""
import json

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.security.permissions import get_current_user
from app.database import get_db
from app.models.user import User
from app.models.user_state import UserState

router = APIRouter(prefix="/me/state", tags=["user-state"])

# Must match SYNCED_KEYS in frontend/src/services/userStateSync.ts
ALLOWED_KEYS = {
    "vju_answer_key",           # active answer key used for grading
    "vju_answer_key_drafts",    # per-template drafts in the Answer Key editor
    "vju_answer_key_library",   # "Lưu vào thư viện" saved answer keys
    "vju_last_template",        # last template picked
}
MAX_VALUE_BYTES = 5 * 1024 * 1024


def _check_key(key: str) -> None:
    if key not in ALLOWED_KEYS:
        raise HTTPException(404, "Không hỗ trợ key này")


@router.get("")
def get_state(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    rows = db.query(UserState).filter(UserState.user_id == user.id).all()
    out = {}
    for r in rows:
        if r.key in ALLOWED_KEYS:
            try:
                out[r.key] = json.loads(r.value_json)
            except ValueError:
                pass
    return out


@router.put("/{key}", status_code=204)
def put_state(
    key: str,
    value: dict | list | None = Body(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    """Store `value` (the JSON the frontend keeps in localStorage); null deletes it."""
    _check_key(key)
    row = db.query(UserState).filter(UserState.user_id == user.id, UserState.key == key).first()
    if value is None:
        if row:
            db.delete(row)
            db.commit()
        return
    text = json.dumps(value, ensure_ascii=False)
    if len(text.encode()) > MAX_VALUE_BYTES:
        raise HTTPException(413, "Dữ liệu quá lớn")
    if row:
        row.value_json = text
    else:
        db.add(UserState(user_id=user.id, key=key, value_json=text))
    db.commit()
