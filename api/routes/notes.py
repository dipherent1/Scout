"""POST /notes: opt-in server copy of a note, interest level and follow-up draft. v1 keeps notes in the browser."""

from fastapi import APIRouter, Depends, HTTPException

import db
from models import NoteIn
from routes.deps import session_id
from services.match import normalize_domain

router = APIRouter()


@router.post("/notes")
def save_note(note: NoteIn, sid: str = Depends(session_id)) -> dict:
    if sid == "anonymous":
        raise HTTPException(400, "X-Scout-Session header required")
    cid = db.company_id(normalize_domain(note.domain))
    if cid is None:
        raise HTTPException(404, "Unknown company")
    db.save_interaction(sid, cid, note.note, note.interest, note.followup_draft)
    return {"ok": True}
