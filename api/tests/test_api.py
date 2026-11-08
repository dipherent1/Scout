import json

from services.limits import limits
from services.match import looks_like_domain, normalize, normalize_domain, score_text
from settings import settings
from models import CompanyRecord
from tests.conftest import SESSION

STRIPE = CompanyRecord(name="Stripe", domain="stripe.com", aliases=["stripe inc"])
APPLE = CompanyRecord(name="Apple", domain="apple.com")


def sse_events(text: str) -> list[tuple[str, dict]]:
    out = []
    for block in text.replace("\r\n", "\n").split("\n\n"):
        event, data = "message", []
        for line in block.split("\n"):
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].strip())
        if data:
            out.append((event, json.loads("\n".join(data))))
    return out


def test_normalize_and_domains():
    assert normalize("Stripe, Inc.") == "stripe"
    assert normalize_domain("https://www.Stripe.com/about?x=1") == "stripe.com"
    assert looks_like_domain("stripe.com")
    assert not looks_like_domain("Stripe")
    assert not looks_like_domain("localhost")


def test_match_mirrors_phone_rules():
    assert score_text("STR1PE", STRIPE) >= 0.85
    assert score_text("Visit Stripe at booth 4", STRIPE) < 0.85  # common word inside a longer line
    assert 0.6 <= score_text("APPLE PIE STAND", APPLE) < 0.85
    assert score_text("FREE COFFEE", STRIPE) < 0.6


def test_health_reports_gemini_off(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["gemini"] is False


def test_bundle_seeded_from_sample(client):
    r = client.get("/bundle/sample")
    assert r.status_code == 200
    names = {c["name"] for c in r.json()["companies"]}
    assert {"Stripe", "Datadog", "Cloudflare"} <= names
    assert client.get("/bundle/Bad Event!").status_code in (400, 404)


def test_scan_text_matches_database(client):
    r = client.post("/scan", json={"texts": ["DATAD0G"]}, headers=SESSION)
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "database"
    assert body["candidates"][0]["domain"] == "datadoghq.com"
    assert body["candidates"][0]["known"] is True


def test_scan_unknown_without_gemini_returns_none(client):
    r = client.post("/scan", json={"texts": ["NOVA ROBOTICS"]}, headers=SESSION)
    assert r.status_code == 200
    assert r.json() == {"candidates": [], "source": "none"}


def test_scan_validates_input(client):
    assert client.post("/scan", json={"texts": []}, headers=SESSION).status_code == 400
    assert client.post("/scan", json={"image_b64": "not base64!!"}, headers=SESSION).status_code == 400


def test_scan_rate_limit(client, monkeypatch):
    monkeypatch.setattr(settings, "scans_per_session_per_day", 2)
    for _ in range(2):
        assert client.post("/scan", json={"texts": ["stripe"]}, headers=SESSION).status_code == 200
    assert client.post("/scan", json={"texts": ["stripe"]}, headers=SESSION).status_code == 429


def test_company_cache_hit_by_domain_and_name(client):
    r = client.get("/company/stripe.com", headers=SESSION)
    assert r.status_code == 200
    assert r.json()["name"] == "Stripe"
    r = client.get("/company/Hugging Face", headers=SESSION)
    assert r.status_code == 200
    assert r.json()["domain"] == "huggingface.co"


def test_company_unknown_name_without_gemini_is_404(client):
    assert client.get("/company/Totally Unknown Co", headers=SESSION).status_code == 404


def test_chat_falls_back_to_profile_based_icebreaker(client):
    company = client.get("/company/datadoghq.com", headers=SESSION).json()
    r = client.post(
        "/chat",
        json={"mode": "icebreaker", "profile": "Backend engineer", "company": company, "messages": []},
        headers=SESSION,
    )
    assert r.status_code == 200
    events = sse_events(r.text)
    text = "".join(d["text"] for e, d in events if e == "token")
    assert "**Icebreaker:**" in text
    assert "Talking points" in text
    assert events[-1] == ("done", {"fallback": True})


def test_chat_question_fallback(client):
    company = client.get("/company/stripe.com", headers=SESSION).json()
    r = client.post(
        "/chat",
        json={"mode": "chat", "profile": "", "company": company, "messages": [{"role": "user", "content": "Are they hiring?"}]},
        headers=SESSION,
    )
    text = "".join(d["text"] for e, d in sse_events(r.text) if e == "token")
    assert "hires" in text.lower() or "hiring" in text.lower()


def test_notes_require_session_and_known_company(client):
    note = {"domain": "stripe.com", "note": "Met Sam from payments infra", "interest": "high"}
    assert client.post("/notes", json=note).status_code == 400
    assert client.post("/notes", json={**note, "domain": "nope.example"}, headers=SESSION).status_code == 404
    assert client.post("/notes", json=note, headers=SESSION).json() == {"ok": True}
    # Upsert, not duplicate
    assert client.post("/notes", json={**note, "interest": "medium"}, headers=SESSION).status_code == 200


def test_spend_cap_disables_gemini(monkeypatch):
    monkeypatch.setattr(settings, "gemini_api_key", "fake")
    monkeypatch.setattr(settings, "daily_spend_cap_usd", 0.01)
    limits.reset()
    assert limits.gemini_allowed()
    limits.record_spend(10_000_000, 0)
    assert not limits.gemini_allowed()
    monkeypatch.setattr(settings, "kill_switch", True)
    limits.reset()
    assert not limits.gemini_allowed()
