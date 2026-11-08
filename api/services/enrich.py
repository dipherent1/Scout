"""On-demand enrichment with a cache keyed by normalized domain (used by GET /company and scripts/warm.py)."""

from __future__ import annotations

import asyncio
import logging
from datetime import timedelta

import db
from models import CompanyRecord
from services import gemini
from services.fetch import fetch_site_text
from services.match import looks_like_domain, match, normalize_domain
from settings import settings

log = logging.getLogger("scout.enrich")

_inflight: dict[str, asyncio.Task[CompanyRecord | None]] = {}


def is_stale(fetched_at) -> bool:
    if fetched_at is None:
        return True
    return db.now() - fetched_at > timedelta(hours=settings.enrichment_ttl_hours)


async def resolve_domain(key: str) -> tuple[str, str]:
    """Turn a domain or a company name into (domain, name_hint)."""
    if looks_like_domain(key):
        return normalize_domain(key), ""
    known = match([key], db.all_companies(), limit=1)
    if known and known[0].score >= 0.85:
        return known[0].company.domain, known[0].company.name
    result = await gemini.read_banner([key], None)
    if result and result.candidates and result.candidates[0].domain:
        top = result.candidates[0]
        return normalize_domain(top.domain), top.name
    return "", key


async def _enrich(domain: str, name_hint: str) -> CompanyRecord | None:
    page_text = await fetch_site_text(domain)
    enrichment = await gemini.enrich(name_hint, domain, page_text)
    if enrichment is None:
        if not name_hint and not page_text:
            return None
        # Degrade to name + link so the phone can still show a card.
        record = CompanyRecord(name=name_hint or domain.split(".")[0].title(), domain=domain, confidence=0.3)
    else:
        record = CompanyRecord(**enrichment.model_dump(exclude={"domain"}), domain=domain, confidence=0.8 if page_text else 0.6)
    if not record.name:
        record.name = name_hint or domain
    db.upsert_company(record)
    return record


async def enrich_domain(domain: str, name_hint: str = "") -> CompanyRecord | None:
    """Enrich once per domain even if several requests arrive at the same time."""
    task = _inflight.get(domain)
    if task is None:
        task = asyncio.create_task(_enrich(domain, name_hint))
        _inflight[domain] = task
        task.add_done_callback(lambda _: _inflight.pop(domain, None))
    return await task


async def get_or_enrich(key: str) -> tuple[CompanyRecord | None, bool]:
    """Returns (record, stale). A stale record is returned immediately; the caller refreshes it in the background."""
    domain, name_hint = await resolve_domain(key)
    if not domain:
        return None, False
    cached = db.get_company(domain)
    if cached:
        record, fetched_at = cached
        return record, is_stale(fetched_at)
    return await enrich_domain(domain, name_hint), False
