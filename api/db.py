"""Database: SQLite to start, Postgres for a real event (set DATABASE_URL). Tables per scout.md."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    create_engine,
    insert,
    select,
    update,
)
from sqlalchemy.engine import Engine

from models import CompanyRecord
from settings import settings

metadata = MetaData()

companies = Table(
    "companies",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("name", String(200), nullable=False),
    Column("domain", String(253), unique=True, index=True, nullable=False),
    Column("aliases", JSON, nullable=False, default=list),
    Column("enrichment", JSON, nullable=False),
    Column("fetched_at", DateTime(timezone=True)),
)

sessions = Table(
    "sessions",
    metadata,
    Column("id", String(64), primary_key=True),
    Column("profile_hash", String(64)),
    Column("created_at", DateTime(timezone=True), nullable=False),
)

interactions = Table(
    "interactions",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("session_id", String(64), ForeignKey("sessions.id"), index=True, nullable=False),
    Column("company_id", Integer, ForeignKey("companies.id"), index=True, nullable=False),
    Column("notes", Text, default=""),
    Column("interest", String(10)),
    Column("followup_draft", Text, default=""),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)

_engine: Engine | None = None


def engine() -> Engine:
    global _engine
    if _engine is None:
        kwargs = {"connect_args": {"check_same_thread": False}} if settings.database_url.startswith("sqlite") else {}
        _engine = create_engine(settings.database_url, **kwargs)
    return _engine


def reset_engine(url: str | None = None) -> None:
    """Used by tests to point at a fresh database."""
    global _engine
    if url:
        settings.database_url = url
    if _engine is not None:
        _engine.dispose()
    _engine = None


def now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def init_db(seed: bool = True) -> None:
    metadata.create_all(engine())
    if seed:
        with engine().connect() as conn:
            empty = conn.execute(select(companies.c.id).limit(1)).first() is None
        if empty and settings.sample_companies_path.exists():
            records = json.loads(settings.sample_companies_path.read_text(encoding="utf-8"))
            for r in records:
                upsert_company(CompanyRecord.model_validate(r))


def _row_to_record(row) -> CompanyRecord:
    return CompanyRecord.model_validate(row.enrichment)


def get_company(domain: str) -> tuple[CompanyRecord, datetime | None] | None:
    with engine().connect() as conn:
        row = conn.execute(select(companies).where(companies.c.domain == domain)).first()
    if row is None:
        return None
    return _row_to_record(row), _aware(row.fetched_at)


def all_companies() -> list[CompanyRecord]:
    with engine().connect() as conn:
        rows = conn.execute(select(companies).order_by(companies.c.name)).all()
    return [_row_to_record(r) for r in rows]


def company_id(domain: str) -> int | None:
    with engine().connect() as conn:
        row = conn.execute(select(companies.c.id).where(companies.c.domain == domain)).first()
    return row.id if row else None


def upsert_company(record: CompanyRecord) -> None:
    data = record.model_dump(mode="json")
    values = {"name": record.name, "aliases": record.aliases, "enrichment": data, "fetched_at": now()}
    with engine().begin() as conn:
        existing = conn.execute(select(companies.c.id).where(companies.c.domain == record.domain)).first()
        if existing:
            conn.execute(update(companies).where(companies.c.id == existing.id).values(**values))
        else:
            conn.execute(insert(companies).values(domain=record.domain, **values))


def profile_hash(profile: str) -> str:
    return hashlib.sha256(profile.strip().encode()).hexdigest() if profile.strip() else ""


def touch_session(session_id: str, profile: str | None = None) -> None:
    """Sessions are anonymous: an id from the phone plus a hash of the profile, never the profile itself."""
    with engine().begin() as conn:
        row = conn.execute(select(sessions.c.id, sessions.c.profile_hash).where(sessions.c.id == session_id)).first()
        if row is None:
            conn.execute(insert(sessions).values(id=session_id, profile_hash=profile_hash(profile or ""), created_at=now()))
        elif profile is not None and row.profile_hash != profile_hash(profile):
            conn.execute(update(sessions).where(sessions.c.id == session_id).values(profile_hash=profile_hash(profile)))


def save_interaction(session_id: str, cid: int, notes: str, interest: str | None, followup: str) -> None:
    touch_session(session_id)
    values = {"notes": notes, "interest": interest, "followup_draft": followup, "updated_at": now()}
    with engine().begin() as conn:
        row = conn.execute(
            select(interactions.c.id).where(interactions.c.session_id == session_id, interactions.c.company_id == cid)
        ).first()
        if row:
            conn.execute(update(interactions).where(interactions.c.id == row.id).values(**values))
        else:
            conn.execute(insert(interactions).values(session_id=session_id, company_id=cid, **values))
