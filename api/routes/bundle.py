"""GET /bundle/{event}: the exhibitor bundle the phone caches at onboarding."""

import json
import re

from fastapi import APIRouter, HTTPException, Response

import db
from models import BundleResponse, CompanyRecord
from settings import settings

router = APIRouter()


@router.get("/bundle/{event}", response_model=BundleResponse)
def get_bundle(event: str, response: Response) -> BundleResponse:
    if not re.fullmatch(r"[a-z0-9-]{1,64}", event):
        raise HTTPException(400, "Bad event id")
    # A bundle exported by scripts/warm.py wins; otherwise serve everything in the database.
    path = settings.bundles_dir / f"{event}.json"
    if path.exists():
        companies = [CompanyRecord.model_validate(c) for c in json.loads(path.read_text(encoding="utf-8"))]
    else:
        companies = db.all_companies()
    response.headers["Cache-Control"] = "public, max-age=300"
    return BundleResponse(event=event, companies=companies)
