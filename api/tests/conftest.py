import pytest
from fastapi.testclient import TestClient

import db
from services.limits import limits
from settings import settings


@pytest.fixture()
def client(tmp_path, monkeypatch):
    # Offline and free: no Gemini key, fresh SQLite file, clean counters.
    monkeypatch.setattr(settings, "gemini_api_key", "")
    db.reset_engine(f"sqlite:///{tmp_path / 'test.db'}")
    monkeypatch.setattr(settings, "bundles_dir", tmp_path / "bundles")
    limits.reset()
    from main import app

    with TestClient(app) as c:
        yield c
    db.reset_engine()


SESSION = {"X-Scout-Session": "test-session-0001"}
