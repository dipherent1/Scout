"""Configuration from environment variables (and the repo-root .env file)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

API_DIR = Path(__file__).resolve().parent
ROOT_DIR = API_DIR.parent
load_dotenv(ROOT_DIR / ".env")
load_dotenv(API_DIR / ".env")


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass
class Settings:
    gemini_api_key: str = field(default_factory=lambda: os.environ.get("GEMINI_API_KEY", ""))
    # Chat quality matters; scan and enrichment favor speed and cost.
    gemini_model: str = field(default_factory=lambda: os.environ.get("GEMINI_MODEL", "gemini-3.5-flash"))
    # Low thinking keeps time-to-first-token near 1 s for chat. Empty = model default.
    gemini_thinking_level: str = field(default_factory=lambda: os.environ.get("GEMINI_THINKING_LEVEL", "minimal"))
    gemini_fast_model: str = field(default_factory=lambda: os.environ.get("GEMINI_FAST_MODEL", "gemini-3.5-flash-lite"))
    database_url: str = field(default_factory=lambda: os.environ.get("DATABASE_URL", f"sqlite:///{API_DIR / 'scout.db'}"))

    # Protections (scout.md, "Protections")
    kill_switch: bool = field(default_factory=lambda: os.environ.get("SCOUT_KILL_SWITCH", "0") == "1")
    daily_spend_cap_usd: float = field(default_factory=lambda: _float("SCOUT_DAILY_SPEND_CAP_USD", 5.0))
    scans_per_session_per_day: int = field(default_factory=lambda: _int("SCOUT_SCANS_PER_DAY", 60))
    chats_per_session_per_day: int = field(default_factory=lambda: _int("SCOUT_CHATS_PER_DAY", 200))
    enrich_per_session_per_day: int = field(default_factory=lambda: _int("SCOUT_ENRICH_PER_DAY", 40))
    # Rough Gemini prices for spend tracking, USD per million tokens. Tune to your model's pricing.
    price_in_per_mtok: float = field(default_factory=lambda: _float("SCOUT_PRICE_IN_PER_MTOK", 0.30))
    price_out_per_mtok: float = field(default_factory=lambda: _float("SCOUT_PRICE_OUT_PER_MTOK", 2.50))

    # Page fetching: "httpx" (default), "jina" (r.jina.ai reader) or "firecrawl" (needs FIRECRAWL_API_KEY)
    fetch_provider: str = field(default_factory=lambda: os.environ.get("SCOUT_FETCH_PROVIDER", "httpx"))
    firecrawl_api_key: str = field(default_factory=lambda: os.environ.get("FIRECRAWL_API_KEY", ""))
    jina_api_key: str = field(default_factory=lambda: os.environ.get("JINA_API_KEY", ""))
    per_domain_interval_s: float = field(default_factory=lambda: _float("SCOUT_PER_DOMAIN_INTERVAL_S", 2.0))
    enrichment_ttl_hours: float = field(default_factory=lambda: _float("SCOUT_ENRICHMENT_TTL_HOURS", 24.0))

    cors_origins: list[str] = field(
        default_factory=lambda: [o for o in os.environ.get("SCOUT_CORS_ORIGINS", "").split(",") if o]
    )
    sample_companies_path: Path = ROOT_DIR / "data" / "sample-companies.json"
    bundles_dir: Path = ROOT_DIR / "data" / "bundles"

    @property
    def gemini_configured(self) -> bool:
        return bool(self.gemini_api_key)


settings = Settings()
