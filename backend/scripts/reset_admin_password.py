"""
Reset (or create) the default admin user.

Run from the backend directory with the venv active:
    cd /Users/choconhatha/Downloads/vju-smart-grading/backend
    source .venv/bin/activate
    python scripts/reset_admin_password.py

This is safe to run at any time:
  - If admin@vju.ac.vn exists  → resets password to 'password', ensures active.
  - If admin@vju.ac.vn missing → creates the user with role=admin.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

ADMIN_EMAIL    = "admin@vju.ac.vn"
ADMIN_NAME     = "Admin VJU"
ADMIN_PASSWORD = "password"

from app.database import SessionLocal, init_db   # noqa: E402
from app.models.user import User                  # noqa: E402
from app.core.security.password import hash_password, verify_password  # noqa: E402

# Ensure tables + columns exist (idempotent)
init_db()

with SessionLocal() as db:
    user = db.query(User).filter(User.email == ADMIN_EMAIL).first()

    if user is None:
        user = User(
            email=ADMIN_EMAIL,
            name=ADMIN_NAME,
            password_hash=hash_password(ADMIN_PASSWORD),
            role="admin",
            is_active=True,
        )
        db.add(user)
        db.commit()
        print(f"✅ Created admin user: {ADMIN_EMAIL}")
        print(f"   Password: {ADMIN_PASSWORD}")
    else:
        # Always reset password so we know the hash is correct
        user.password_hash = hash_password(ADMIN_PASSWORD)
        user.is_active = True
        user.role = "admin"
        db.commit()
        print(f"✅ Reset admin user: {ADMIN_EMAIL}")
        print(f"   Password reset to: {ADMIN_PASSWORD}")
        print(f"   Active: {user.is_active}  Role: {user.role}")

    # Verify the hash works
    db.refresh(user)
    ok = verify_password(ADMIN_PASSWORD, user.password_hash)
    print(f"   Password verify: {'✅ OK' if ok else '❌ FAILED'}")
