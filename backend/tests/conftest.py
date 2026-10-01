"""Shared fixtures: an API client on a throw-away SQLite DB with two teachers
(ids 1 and 2); client.headers_for(user_id) gives that user's auth header."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))


@pytest.fixture()
def client(tmp_path, monkeypatch):
    # Word files of bộ đề giữ định dạng go to a throw-away folder too
    import app.services.exam_paper_service as eps
    monkeypatch.setattr(eps, "SOURCES_DIR", tmp_path / "exam_paper_sources")
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    import app.models  # noqa: F401
    from app.core.security.jwt import create_access_token
    from app.database import Base, get_db
    from app.main import app
    from app.models.user import User

    engine = create_engine(f"sqlite:///{tmp_path / 'test.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    with Session() as db:
        for email, role in (("t1@vju.ac.vn", "teacher"), ("t2@vju.ac.vn", "teacher")):
            db.add(User(email=email, name=email, password_hash="x", role=role, is_active=True))
        db.commit()

    def _get_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _get_db
    c = TestClient(app)
    c.headers_for = lambda uid: {"Authorization": f"Bearer {create_access_token(uid)}"}
    yield c
    app.dependency_overrides.clear()
