"""Per-session daily limits, a global daily spend cap and a kill switch.

In-memory, which is fine for one API process. Move the counters to the
database (or Redis) only if you run several API replicas.
"""

from __future__ import annotations

import threading
from collections import defaultdict
from datetime import date

from fastapi import HTTPException

from settings import settings


class Limits:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counts: dict[tuple[str, str, date], int] = defaultdict(int)
        self._spend: dict[date, float] = defaultdict(float)

    def reset(self) -> None:
        with self._lock:
            self._counts.clear()
            self._spend.clear()

    def check(self, session_id: str, kind: str) -> None:
        """Count one request of `kind` for this session or raise 429."""
        cap = {
            "scan": settings.scans_per_session_per_day,
            "chat": settings.chats_per_session_per_day,
            "enrich": settings.enrich_per_session_per_day,
        }[kind]
        key = (session_id or "anonymous", kind, date.today())
        with self._lock:
            if self._counts[key] >= cap:
                raise HTTPException(429, f"Daily {kind} limit reached for this session")
            self._counts[key] += 1

    def record_spend(self, input_tokens: int, output_tokens: int) -> float:
        cost = (input_tokens * settings.price_in_per_mtok + output_tokens * settings.price_out_per_mtok) / 1_000_000
        with self._lock:
            self._spend[date.today()] += cost
        return cost

    def spend_today(self) -> float:
        return self._spend[date.today()]

    def gemini_allowed(self) -> bool:
        if settings.kill_switch or not settings.gemini_configured:
            return False
        return self.spend_today() < settings.daily_spend_cap_usd


limits = Limits()
