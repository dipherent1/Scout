"""GET /company/{key}: cached record, or on-demand enrichment on a miss. `key` is a domain or a company name."""

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException

from models import CompanyRecord
from routes.deps import session_id
from services import enrich
from services.limits import limits

router = APIRouter()


@router.get("/company/{key}", response_model=CompanyRecord)
async def get_company(key: str, background: BackgroundTasks, sid: str = Depends(session_id)) -> CompanyRecord:
    key = key.strip()
    if not key or len(key) > 200:
        raise HTTPException(400, "Bad company key")
    limits.check(sid, "enrich")
    record, stale = await enrich.get_or_enrich(key)
    if record is None:
        raise HTTPException(404, "Company not found")
    if stale:
        # Stale-while-revalidate: answer now, refresh for the next request.
        background.add_task(enrich.enrich_domain, record.domain, record.name)
    return record
