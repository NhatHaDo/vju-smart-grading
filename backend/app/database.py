from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.config import get_settings

settings = get_settings()

engine = create_engine(
    settings.database_url,
    connect_args={"check_same_thread": False},  # SQLite only
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    """FastAPI dependency — yields a DB session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _migrate_exam_columns() -> None:
    """
    Safe incremental migration for SQLite: adds any missing columns to the
    `exams` table without dropping existing data.  Called automatically by
    init_db() so restarting the server is sufficient to migrate.
    """
    NEW_COLUMNS: list[tuple[str, str]] = [
        ("subject_code",     "VARCHAR(50)"),
        ("semester",         "VARCHAR(10)"),
        ("academic_year",    "VARCHAR(20)"),
        ("lecturer_title",   "VARCHAR(20)"),
        ("lecturer_name",    "VARCHAR(255)"),
        ("class_name",       "VARCHAR(100)"),
        ("faculty",          "VARCHAR(20)"),
        ("training_program", "VARCHAR(255)"),
        ("exam_time",        "VARCHAR(10)"),
        ("room",             "VARCHAR(100)"),
        ("shift",            "VARCHAR(50)"),
    ]
    try:
        with engine.connect() as conn:
            # Only works for SQLite; skip gracefully for other backends
            result = conn.execute(__import__("sqlalchemy").text("PRAGMA table_info(exams)"))
            existing = {row[1] for row in result}
            for col, typ in NEW_COLUMNS:
                if col not in existing:
                    conn.execute(__import__("sqlalchemy").text(
                        f"ALTER TABLE exams ADD COLUMN {col} {typ}"
                    ))
                    conn.commit()
    except Exception:
        # Non-SQLite DBs or table-not-yet-created: create_all below handles it
        pass


def _migrate_template_columns() -> None:
    """
    Safe incremental migration: adds new custom-template columns to the
    `templates` table without touching existing rows or dropping data.
    """
    NEW_COLUMNS: list[tuple[str, str]] = [
        ("areas_path",    "VARCHAR(512)"),
        ("page_width",    "INTEGER"),
        ("page_height",   "INTEGER"),
        ("owner_user_id", "INTEGER"),
        ("is_default",    "BOOLEAN NOT NULL DEFAULT 0"),
    ]
    try:
        import sqlalchemy as _sa
        with engine.connect() as conn:
            result = conn.execute(_sa.text("PRAGMA table_info(templates)"))
            existing = {row[1] for row in result}
            for col, typ in NEW_COLUMNS:
                if col not in existing:
                    conn.execute(_sa.text(f"ALTER TABLE templates ADD COLUMN {col} {typ}"))
                    conn.commit()
    except Exception:
        pass



def _migrate_batch_result_columns() -> None:
    """
    Safe incremental migration: adds ma_ctdt + tu_chon columns to
    batch_results table without touching existing rows or dropping data.
    """
    NEW_COLUMNS: list[tuple[str, str]] = [
        ('ma_ctdt', 'VARCHAR(50)'),
        ('tu_chon', 'VARCHAR(10)'),
    ]
    try:
        import sqlalchemy as _sa
        with engine.connect() as conn:
            result = conn.execute(_sa.text('PRAGMA table_info(batch_results)'))
            existing = {row[1] for row in result}
            for col, typ in NEW_COLUMNS:
                if col not in existing:
                    conn.execute(_sa.text(f'ALTER TABLE batch_results ADD COLUMN {col} {typ}'))
                    conn.commit()
    except Exception:
        pass


_ADMIN_EMAIL    = "admin@vju.ac.vn"
_ADMIN_PASSWORD = "password"


def _seed_admin_user() -> None:
    """
    Ensure the default admin user exists.
    - Checks by EMAIL (not just row count) so it's safe when other users exist.
    - If the user is absent → creates it with bcrypt-hashed password.
    - If the user already exists → leaves it untouched.
    - Logs outcome so admins can confirm seed on server startup.
    - Errors are logged as warnings, never silently swallowed.

    Credentials: admin@vju.ac.vn / password
    To reset the password run: python scripts/reset_admin_password.py
    """
    import logging
    _log = logging.getLogger(__name__)

    try:
        from app.core.security.password import hash_password
        from app.models.user import User

        with SessionLocal() as db:
            user = db.query(User).filter(User.email == _ADMIN_EMAIL).first()
            if user is None:
                admin = User(
                    email=_ADMIN_EMAIL,
                    name="Admin VJU",
                    password_hash=hash_password(_ADMIN_PASSWORD),
                    role="admin",
                    is_active=True,
                )
                db.add(admin)
                db.commit()
                _log.info("[SEED] Created admin user: %s", _ADMIN_EMAIL)
            else:
                _log.info("[SEED] Admin user exists: %s (id=%d, active=%s)",
                          _ADMIN_EMAIL, user.id, user.is_active)
    except Exception as exc:
        import logging as _logging
        _logging.getLogger(__name__).warning(
            "[SEED] Could not seed admin user: %s — "
            "run python scripts/reset_admin_password.py manually", exc
        )


def init_db() -> None:
    """Create all tables, run incremental migrations, and seed initial data."""
    # Import models so they are registered on Base before create_all
    import app.models  # noqa: F401
    Base.metadata.create_all(bind=engine)
    _migrate_exam_columns()
    _migrate_template_columns()
    _migrate_batch_result_columns()
    _seed_admin_user()
