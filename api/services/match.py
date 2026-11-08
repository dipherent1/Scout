"""Normalize + fuzzy match company names. Mirrors web/src/match/matcher.ts so phone and server agree."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from rapidfuzz import fuzz

from models import CompanyRecord

_SUFFIX_RE = re.compile(r"\b(incorporated|inc|llc|ltd|limited|corp|corporation|co|gmbh|plc|sa|ag|hq)\b")
_OCR_FIX = str.maketrans({"0": "o", "1": "l", "5": "s", "8": "b", "|": "l", "$": "s"})

COMMON_WORDS = {
    "apple", "notion", "ramp", "linear", "stripe", "snowflake", "square", "block", "box",
    "slack", "zoom", "signal", "shopify", "oracle", "amazon", "meta", "target", "gap",
}
AMBIGUOUS_CAP = 0.78
SUBSTRING_PENALTY = 0.96


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    text = _SUFFIX_RE.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip()


def ocr_folds(text: str) -> list[str]:
    """Alternate readings undoing OCR digit swaps; "1" is tried as both "l" and "i"."""
    as_l = text.translate(_OCR_FIX)
    as_i = text.replace("1", "i").translate(_OCR_FIX)
    return [as_l] if as_l == as_i else [as_l, as_i]


def normalize_domain(value: str) -> str:
    v = value.strip().lower()
    v = re.sub(r"^[a-z]+://", "", v)
    v = v.split("/")[0].split("?")[0].split("#")[0].split(":")[0]
    return v.removeprefix("www.")


_DOMAIN_RE = re.compile(r"^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$")


def looks_like_domain(value: str) -> bool:
    return bool(_DOMAIN_RE.match(normalize_domain(value)))


def _full(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return max(fuzz.ratio(a, b), fuzz.token_sort_ratio(a, b)) / 100


def _ngrams(tokens: list[str], max_len: int) -> list[str]:
    out = []
    for n in range(1, min(max_len, len(tokens)) + 1):
        for i in range(len(tokens) - n + 1):
            out.append(" ".join(tokens[i : i + n]))
    return out


@dataclass
class Match:
    company: CompanyRecord
    score: float


def _keys(c: CompanyRecord) -> set[str]:
    keys = {normalize(c.name), *(normalize(a) for a in c.aliases)}
    stem = normalize(normalize_domain(c.domain).split(".")[0]) if c.domain else ""
    if len(stem) >= 4:
        keys.add(stem)
    return {k for k in keys if k}


def score_text(text: str, company: CompanyRecord) -> float:
    q = normalize(text)
    if len(q.replace(" ", "")) < 2:
        return 0.0
    variants = {q, *(normalize(f) for f in ocr_folds(text))}
    best = 0.0
    for key in _keys(company):
        key_tokens = len(key.split())
        common = key in COMMON_WORDS
        for v in variants:
            if len(key) <= 2:
                best = max(best, 1.0 if v == key else 0.0)
                continue
            best = max(best, _full(v, key))
            tokens = v.split()
            if len(tokens) > key_tokens:
                for gram in _ngrams(tokens, key_tokens + 1):
                    if len(gram) < 3:
                        continue
                    s = _full(gram, key) * SUBSTRING_PENALTY
                    if common:
                        s = min(s, AMBIGUOUS_CAP)
                    best = max(best, s)
    return best


def match(texts: list[str], companies: list[CompanyRecord], limit: int = 3) -> list[Match]:
    scored: dict[str, Match] = {}
    for text in texts:
        for c in companies:
            s = score_text(text, c)
            if s > (scored[c.domain].score if c.domain in scored else 0):
                scored[c.domain] = Match(c, s)
    return sorted(scored.values(), key=lambda m: m.score, reverse=True)[:limit]
