"""POST /chat: SSE stream of the copilot. Profile + company record + last N messages into Gemini.

Events: `token` {"text"}, `sources` {"sources": [{"title", "url"}]}, `done` {"fallback": bool}.
If Gemini is unavailable or slow to start, streams a profile-based answer from
the company record instead of failing.
"""

import asyncio
import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends
from google.genai import types
from sse_starlette.sse import EventSourceResponse

import db
from models import ChatRequest, CompanyRecord
from routes.deps import session_id
from services import gemini
from services.gemini import GeminiUnavailable, untrusted
from services.limits import limits

router = APIRouter()

HISTORY_LIMIT = 10

SYSTEM = """You are Scout, a networking copilot for someone walking around a conference or career fair.
You help them start and hold a good conversation at one company's booth.

Style: concise, warm, specific. Speak to the user as "you". No preamble.
Ground everything in the company record, the user's profile and (when available) search results.
Never invent facts, numbers, people or news. If you are unsure, say so briefly.
When you use search results, keep claims short and let the cited sources speak.

""" + gemini.INJECTION_RULE


MODE_PROMPTS = {
    "icebreaker": (
        "Write my opener for this booth. Format exactly:\n"
        "**Icebreaker:** one or two natural sentences I can say out loud, connecting my background to their work.\n\n"
        "**Talking points:**\n- three short, specific bullets I can bring up"
    ),
    "followup": (
        "Draft a short follow-up message (under 90 words) I can send to the person I met at this booth today. "
        "Mention one specific thing from my note if there is one. Plain text, no subject line, no placeholders in brackets."
    ),
}


def _context(req: ChatRequest) -> str:
    c = req.company.model_dump(exclude={"embedding", "brand_color", "logo_url", "confidence"})
    parts = [
        untrusted("user_profile", req.profile or "(The user has not shared a profile.)"),
        untrusted("company_record", json.dumps(c, ensure_ascii=False)),
    ]
    if req.note:
        parts.append(untrusted("user_note", req.note))
    return "\n\n".join(parts)


def build_contents(req: ChatRequest) -> list[types.Content]:
    contents = [
        types.Content(role="user", parts=[types.Part.from_text(text=_context(req))]),
        types.Content(role="model", parts=[types.Part.from_text(text="Got it. I'll use only that as data.")]),
    ]
    for m in req.messages[-HISTORY_LIMIT:]:
        contents.append(types.Content(role="model" if m.role == "assistant" else "user", parts=[types.Part.from_text(text=m.content)]))
    if req.mode in MODE_PROMPTS:
        contents.append(types.Content(role="user", parts=[types.Part.from_text(text=MODE_PROMPTS[req.mode])]))
    elif not req.messages or req.messages[-1].role != "user":
        contents.append(types.Content(role="user", parts=[types.Part.from_text(text="What should I ask them?")]))
    return contents


def fallback_text(req: ChatRequest) -> str:
    """Profile-based answer from the company record (no model call)."""
    c: CompanyRecord = req.company
    points = c.talking_points[:3] or [f"What {c.name} is focused on this year"]
    if req.mode == "followup":
        about = f" about {points[0].lower()}" if points else ""
        return f"Hi, thanks for chatting at the {c.name} booth today. I'd love to keep the conversation going{about}. Would you have 15 minutes next week?"
    if req.mode == "icebreaker":
        hook = points[0][0].lower() + points[0][1:]
        bullets = "\n".join(f"- {p}" for p in points)
        return f"**Icebreaker:** Hi! I've been curious about {hook}. How does your team think about it?\n\n**Talking points:**\n{bullets}"
    question = req.messages[-1].content.lower() if req.messages else ""
    if "news" in question or "recent" in question:
        if c.recent_news:
            return "\n".join(f"- [{n.title}]({n.url})" for n in c.recent_news[:3])
        return f"I can't search for fresh news right now. Ask them what {c.name} shipped recently, or about {(c.products or ['their main product'])[0]}."
    if "hiring" in question or "role" in question or "job" in question:
        return c.hiring_signals or f"I don't have hiring info for {c.name}. Ask which teams are growing."
    return f"{c.summary}\n\nGood angles: {'; '.join(points[:2])}."


async def _chunks(text: str) -> AsyncIterator[str]:
    words = text.split(" ")
    for i in range(0, len(words), 3):
        yield " ".join(words[i : i + 3]) + (" " if i + 3 < len(words) else "")
        await asyncio.sleep(0.02)


@router.post("/chat")
async def chat(req: ChatRequest, sid: str = Depends(session_id)) -> EventSourceResponse:
    limits.check(sid, "chat")
    if sid != "anonymous":
        db.touch_session(sid, req.profile)

    async def events():
        used_fallback = False
        try:
            async for ev in gemini.stream_chat(
                SYSTEM, build_contents(req), grounded=req.mode == "chat", first_token_timeout=14.0 if req.mode == "chat" else 7.0
            ):
                if ev["type"] == "token":
                    yield {"event": "token", "data": json.dumps({"text": ev["text"]})}
                elif ev["type"] == "sources":
                    yield {"event": "sources", "data": json.dumps({"sources": ev["sources"]})}
        except GeminiUnavailable:
            used_fallback = True
            async for chunk in _chunks(fallback_text(req)):
                yield {"event": "token", "data": json.dumps({"text": chunk})}
        yield {"event": "done", "data": json.dumps({"fallback": used_fallback})}

    return EventSourceResponse(events(), ping=15)
