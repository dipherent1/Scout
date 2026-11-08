"""Scout API. Run from this folder: `uv run uvicorn main:app --reload --port 8000`."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import db
from routes import bundle, chat, company, notes, scan
from services import gemini
from services.limits import limits
from settings import settings

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init_db()
    yield


app = FastAPI(title="Scout API", version="0.1.0", lifespan=lifespan)

if settings.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "X-Scout-Session"],
    )

for r in (scan, company, chat, bundle, notes):
    app.include_router(r.router)


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "gemini": gemini.enabled(),
        "kill_switch": settings.kill_switch,
        "spend_today_usd": round(limits.spend_today(), 4),
        "spend_cap_usd": settings.daily_spend_cap_usd,
    }
