"""Pydantic schemas: the company record (also the on-device bundle shape), scan and chat payloads."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class NewsItem(BaseModel):
    title: str = ""
    url: str = ""
    date: str = ""


class CompanyEnrichment(BaseModel):
    """What Gemini returns for a company (structured output). No embedding or UI fields."""

    name: str
    domain: str = ""
    aliases: list[str] = Field(default_factory=list, description="Other names or spellings people use")
    summary: str = Field("", description="Exactly two sentences, plain language, what the company does")
    focus_areas: list[str] = Field(default_factory=list, description="3-6 short lowercase topic tags")
    products: list[str] = Field(default_factory=list)
    hiring_signals: str = Field("", description="One sentence on what roles they seem to hire for, or empty")
    talking_points: list[str] = Field(default_factory=list, description="3 specific conversation topics")


class CompanyRecord(CompanyEnrichment):
    recent_news: list[NewsItem] = Field(default_factory=list)
    embedding: list[float] = Field(default_factory=list)
    confidence: float = 0.0
    brand_color: str | None = None
    logo_url: str | None = None


class ScanRequest(BaseModel):
    texts: list[str] = Field(default_factory=list, max_length=12)
    # Downscaled JPEG crop from the phone, base64 without the data: prefix. Never stored.
    image_b64: str | None = Field(None, max_length=1_500_000)


class ScanCandidate(BaseModel):
    name: str
    domain: str = ""
    confidence: float = 0.0
    known: bool = False


class ScanResponse(BaseModel):
    candidates: list[ScanCandidate]
    source: Literal["database", "gemini", "none"]


class GeminiBannerCandidate(BaseModel):
    name: str = Field(description="Company or organization name as it is officially written")
    domain: str = Field("", description="Official website domain, like example.com, or empty if unsure")
    confidence: float = Field(description="0 to 1, how sure you are this company is shown")


class GeminiBannerResult(BaseModel):
    candidates: list[GeminiBannerCandidate] = Field(default_factory=list)


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=6000)


class ChatRequest(BaseModel):
    mode: Literal["icebreaker", "chat", "followup"] = "chat"
    profile: str = Field("", max_length=4000)
    company: CompanyRecord
    messages: list[ChatTurn] = Field(default_factory=list, max_length=24)
    note: str | None = Field(None, max_length=2000)


class NoteIn(BaseModel):
    domain: str = Field(max_length=253)
    note: str = Field("", max_length=4000)
    interest: Literal["high", "medium", "low"] | None = None
    followup_draft: str = Field("", max_length=4000)


class BundleResponse(BaseModel):
    event: str
    companies: list[CompanyRecord]
