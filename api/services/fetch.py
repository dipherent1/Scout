"""Fetch a company's homepage and about page as plain text.

Respects robots.txt, rate-limits per domain, refuses private/internal hosts
(no SSRF), and supports Jina Reader or Firecrawl when configured.
"""

from __future__ import annotations

import asyncio
import html
import ipaddress
import logging
import re
import socket
import time
from urllib.robotparser import RobotFileParser

import httpx

from services.match import looks_like_domain, normalize_domain
from settings import settings

log = logging.getLogger("scout.fetch")

USER_AGENT = "ScoutBot/0.1 (+event networking assistant; respects robots.txt)"
ABOUT_PATHS = ["/about", "/company", "/about-us"]
MAX_CHARS_PER_PAGE = 8000

_last_hit: dict[str, float] = {}
_domain_locks: dict[str, asyncio.Lock] = {}


class FetchRefused(Exception):
    pass


async def _assert_public(domain: str) -> None:
    if not looks_like_domain(domain) or domain.endswith((".local", ".internal", ".localhost", ".lan")):
        raise FetchRefused(f"not a public domain: {domain}")
    try:
        infos = await asyncio.to_thread(socket.getaddrinfo, domain, 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror as e:
        raise FetchRefused(f"cannot resolve {domain}") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise FetchRefused(f"{domain} resolves to a non-public address")


async def _rate_limit(domain: str) -> None:
    lock = _domain_locks.setdefault(domain, asyncio.Lock())
    async with lock:
        wait = settings.per_domain_interval_s - (time.monotonic() - _last_hit.get(domain, 0))
        if wait > 0:
            await asyncio.sleep(wait)
        _last_hit[domain] = time.monotonic()


async def _robots(client: httpx.AsyncClient, domain: str) -> RobotFileParser:
    rp = RobotFileParser()
    try:
        r = await client.get(f"https://{domain}/robots.txt", timeout=5)
        rp.parse(r.text.splitlines() if r.status_code == 200 else [])
    except httpx.HTTPError:
        rp.parse([])
    return rp


_DROP_BLOCKS = re.compile(r"<(script|style|noscript|svg|nav|footer|header|form|iframe)[^>]*>.*?</\1>", re.S | re.I)
_TAGS = re.compile(r"<[^>]+>")


def html_to_text(raw: str) -> str:
    title = re.search(r"<title[^>]*>(.*?)</title>", raw, re.S | re.I)
    desc = re.search(r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']*)', raw, re.I)
    body = _DROP_BLOCKS.sub(" ", raw)
    body = _TAGS.sub(" ", body)
    text = html.unescape(re.sub(r"\s+", " ", body)).strip()
    head = " | ".join(html.unescape(m.group(1).strip()) for m in (title, desc) if m)
    return (head + "\n" + text).strip()[:MAX_CHARS_PER_PAGE]


async def _get_httpx(client: httpx.AsyncClient, url: str) -> str:
    r = await client.get(url, timeout=10, follow_redirects=True)
    if r.status_code != 200 or "html" not in r.headers.get("content-type", ""):
        return ""
    return html_to_text(r.text)


async def _get_jina(client: httpx.AsyncClient, url: str) -> str:
    headers = {"Authorization": f"Bearer {settings.jina_api_key}"} if settings.jina_api_key else {}
    r = await client.get(f"https://r.jina.ai/{url}", headers=headers, timeout=20)
    return r.text[:MAX_CHARS_PER_PAGE] if r.status_code == 200 else ""


async def _get_firecrawl(client: httpx.AsyncClient, url: str) -> str:
    r = await client.post(
        "https://api.firecrawl.dev/v1/scrape",
        headers={"Authorization": f"Bearer {settings.firecrawl_api_key}"},
        json={"url": url, "formats": ["markdown"], "onlyMainContent": True},
        timeout=30,
    )
    if r.status_code != 200:
        return ""
    return (r.json().get("data", {}).get("markdown") or "")[:MAX_CHARS_PER_PAGE]


async def fetch_site_text(domain: str) -> str:
    """Homepage plus the first about-style page that exists. Returns '' on any failure."""
    domain = normalize_domain(domain)
    try:
        await _assert_public(domain)
    except FetchRefused as e:
        log.info("fetch refused: %s", e)
        return ""
    provider = settings.fetch_provider
    if provider == "firecrawl" and not settings.firecrawl_api_key:
        provider = "httpx"
    getter = {"jina": _get_jina, "firecrawl": _get_firecrawl}.get(provider, _get_httpx)

    texts: list[str] = []
    async with httpx.AsyncClient(headers={"User-Agent": USER_AGENT}) as client:
        robots = await _robots(client, domain)
        for path in ["/", *ABOUT_PATHS]:
            url = f"https://{domain}{path}"
            if not robots.can_fetch(USER_AGENT, url):
                continue
            await _rate_limit(domain)
            try:
                text = await getter(client, url)
            except httpx.HTTPError as e:
                log.info("fetch %s failed: %s", url, e)
                text = ""
            if text:
                texts.append(f"[{url}]\n{text}")
            if path != "/" and text:
                break  # one about page is enough
    return "\n\n".join(texts)
