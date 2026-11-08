"""POST /scan: the phone could not match locally. Fuzzy match against the database, then Gemini vision."""

from fastapi import APIRouter, Depends, HTTPException

import db
from models import ScanCandidate, ScanRequest, ScanResponse
from routes.deps import session_id
from services import gemini
from services.limits import limits
from services.match import match, normalize_domain

router = APIRouter()

DB_LOCK_SCORE = 0.85


@router.post("/scan", response_model=ScanResponse)
async def scan(req: ScanRequest, sid: str = Depends(session_id)) -> ScanResponse:
    texts = [t.strip()[:120] for t in req.texts if t.strip()]
    image = gemini.decode_image(req.image_b64)
    if req.image_b64 and image is None:
        raise HTTPException(400, "image_b64 is not valid base64")
    if not texts and not image:
        raise HTTPException(400, "Send texts or image_b64")
    limits.check(sid, "scan")

    companies = db.all_companies()
    if texts:
        local = match(texts, companies)
        if local and local[0].score >= DB_LOCK_SCORE:
            return ScanResponse(
                source="database",
                candidates=[ScanCandidate(name=m.company.name, domain=m.company.domain, confidence=round(m.score, 3), known=True) for m in local if m.score >= 0.6],
            )

    # The image is passed straight through to Gemini and never written anywhere.
    result = await gemini.read_banner(texts, image)
    if not result or not result.candidates:
        return ScanResponse(source="none", candidates=[])

    by_domain = {c.domain: c for c in companies}
    out: list[ScanCandidate] = []
    for cand in result.candidates[:3]:
        domain = normalize_domain(cand.domain) if cand.domain else ""
        known = domain in by_domain
        if not known:
            # Gemini may spell the domain differently; check names too.
            m = match([cand.name], companies, limit=1)
            if m and m[0].score >= DB_LOCK_SCORE:
                domain, known = m[0].company.domain, True
        name = by_domain[domain].name if known else cand.name
        out.append(ScanCandidate(name=name, domain=domain, confidence=round(max(0.0, min(1.0, cand.confidence)), 3), known=known))
    return ScanResponse(source="gemini", candidates=out)
