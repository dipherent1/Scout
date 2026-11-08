"""Warm-up: exhibitor CSV -> enrichment -> database -> phone bundle.

    cd api
    uv run python ../scripts/warm.py ../data/exhibitors.example.csv --event demo

CSV columns: name, domain (domain optional; Gemini guesses it from the name).
Runs the same enrichment as GET /company with limited concurrency, then writes
data/bundles/<event>.json, which GET /bundle/<event> serves to phones.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parent.parent / "api"
sys.path.insert(0, str(API_DIR))

import db  # noqa: E402
from services import enrich  # noqa: E402
from services.match import looks_like_domain, normalize_domain  # noqa: E402
from settings import settings  # noqa: E402


async def warm_one(sem: asyncio.Semaphore, name: str, domain: str, force: bool) -> tuple[str, str]:
    async with sem:
        key = domain or name
        if domain and looks_like_domain(domain):
            domain = normalize_domain(domain)
            cached = db.get_company(domain)
            if cached and not force and not enrich.is_stale(cached[1]):
                return name, "cached"
            record = await enrich.enrich_domain(domain, name)
        else:
            record, _ = await enrich.get_or_enrich(key)
        return name, ("ok " + record.domain) if record else "FAILED"


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv", type=Path)
    ap.add_argument("--event", default="sample", help="bundle id served at /bundle/<event>")
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--force", action="store_true", help="re-enrich even if cached and fresh")
    args = ap.parse_args()

    db.init_db()
    rows = list(csv.DictReader(args.csv.open(encoding="utf-8-sig")))
    sem = asyncio.Semaphore(args.concurrency)
    results = await asyncio.gather(
        *(warm_one(sem, (r.get("name") or "").strip(), (r.get("domain") or "").strip(), args.force) for r in rows)
    )
    for name, status in results:
        print(f"{status:>28}  {name}")

    wanted = {normalize_domain(r["domain"]) for r in rows if r.get("domain")}
    names = {(r.get("name") or "").strip().lower() for r in rows}
    companies = [c for c in db.all_companies() if c.domain in wanted or c.name.lower() in names]
    settings.bundles_dir.mkdir(parents=True, exist_ok=True)
    out = settings.bundles_dir / f"{args.event}.json"
    out.write_text(json.dumps([c.model_dump(mode="json") for c in companies], indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"\nWrote {len(companies)} companies to {out} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    asyncio.run(main())
