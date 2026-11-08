# Scout: project context

Nov 7, 2026 · @Binyam

Scout is a browser-based, camera-first networking copilot for events. The design is settled enough to start building, with no code written yet. Build the phone prototype of the camera and overlay layer first (see Build order and next step). Paste or share this doc with any new session to bring it up to speed.

## Product and user flow

Point a phone at a company booth, get a summary and a personalized icebreaker before walking up. It runs in the browser (no install) and works at any event. An exhibitor list makes it faster but is not required.

1. **Onboarding(optional)****:** the user scans a QR code or opens a link and pastes a short bio, resume text or a few bullets (for example "Backend engineer looking for infrastructure roles"). No LinkedIn URL, because it cannot be scraped legitimately. The profile stays in the browser and is sent with each request, so no account is needed.
2. **Live camera:** the camera view looks alive. Faint boxes flicker over detected text, and a reticle springs onto a banner when a company is recognized.
3. **Recognition:** on-device text detection reads the banner and matches it against a local exhibitor list. Unmatched or low-confidence crops go to Gemini vision as a fallback. A scan never dead-ends: candidate chips ("Did you mean...") and a manual search box are always available.
4. **Info card:** a bottom sheet peeks up with name and logo, then the two-sentence summary, then a "why this fits you" line.
5. **Copilot chat:** tapping the card opens a streamed, personalized icebreaker plus two or three talking points. The icebreaker starts generating as soon as a box locks, so the first line is ready when the user taps.
6. **Live Q&A:** follow-up questions ("What recent news should I mention?") stream back with sources, using Gemini's Google Search grounding.
7. **After the booth:** save a note, mark interest, draft a follow-up message, and get an end-of-day list of who to contact.

**Alive-feeling interaction ideas:** lock-on spring animation with haptic buzz on Android; 60 fps box interpolation over 5-10 fps detections; AR-style chips anchored to each box so several booths show at once; relevance coloring (green, amber, neutral) from an embedding of the user's bio against every exhibitor; a dwell cue that auto-expands the card after about 2 seconds. Rule: never fake detections, idle animation only.

## Architecture

The live loop runs on the phone so scanning costs nothing per frame and feels instant. The server is only a fallback for unknown companies, plus chat and enrichment. This is the third revision: v1 streamed frames to Cloud Vision at 2 fps, v2 switched to tap-to-scan, and v3 (current) moves detection on-device.

```text
BROWSER (Vue 3 + Vite PWA)
  <video> -> requestVideoFrameCallback -> Web Worker
     Worker: ONNX Runtime Web (WebGPU, WASM fallback)
             text detection at 5-10 fps
     Local store (IndexedDB): exhibitors, aliases, summaries,
             tags, embeddings; model cached by service worker
     Fuzzy matcher (<50 ms) -> card shows instantly from local data
     Tracker/animation layer: spring or Kalman smoothing at 60 fps
     Profile in localStorage; embedding of bio -> relevance colors
        |
        | only when text is stable but unmatched / low confidence
        v
FASTAPI (single Python service)
  POST /scan     cropped frame -> Gemini vision -> company candidates
  GET  /company  cache lookup, else on-demand enrichment
  POST /chat     SSE stream: Gemini with profile + company + history,
                 Google Search grounding for fresh questions
  Rate limits, daily spend cap, input sanitizing
        |
        v
POSTGRES (SQLite to start): companies, sessions, interactions
        ^
        | optional warm-up: python warm.py exhibitors.csv
        |   fetch pages -> Gemini structured summary -> store -> export
        |   to the phone bundle
```

**Latency budget (mid-range phone):** frame to text boxes under 150 ms; text to company match under 50 ms; match to card instant (local); tap to first icebreaker token under 500 ms (prefetched).

**Fallback path:** if the device cannot run the detector (older iPhones, no WebGPU, weak WASM), detect capability at startup and fall back to tap-to-scan with server OCR. That path must keep working.

**Pre-warm is now core, not optional:** the local exhibitor bundle (a few hundred KB) is what makes the card instant. The on-demand enrichment path still covers events with no exhibitor list and any company missing from the bundle.

## Scan pipeline: phone versus server

Rule of thumb: the phone does the fast, repeated work; the server only helps when the phone is stuck. Think of a person with a printed cheat sheet of every exhibitor who phones a friend only when a banner is not on the sheet.

**One-time setup at onboarding:** the browser downloads and caches the exhibitor bundle (a few hundred KB: names, aliases, summaries, tags, embeddings) and the text-detection model (about 4-10 MB). After that, a normal scan needs no network.

**Per frame, on the phone (5-10 times a second):**

1. The `<video>` element plays the camera feed; `requestVideoFrameCallback` hands a frame to a Web Worker.
2. The worker runs the text detector and returns text boxes plus recognized strings.
3. The matcher normalizes the strings and fuzzy-matches them against the local bundle (under 50 ms).
4. On a match, the tracker locks a box, the card opens from local data, and the speculative icebreaker request starts.

**When the server gets involved:**

| Situation | What the phone does | Starting threshold (tune in the field) |
| --- | --- | --- |
| Strong local match | Lock box, show card, no network | match score 0.85 or higher |
| Plausible but unsure | Show candidate chips ("Did you mean...") | score 0.60 to 0.85 |
| Text visible but no match, image stable | Crop the banner, call `POST /scan`, show "reading..." shimmer | no score above 0.60 for about 3 stable frames (roughly 400 ms) |
| Nothing readable | Keep idle animation; manual search box always visible | no text detected |
| Device cannot run the detector | Switch to tap-to-scan: take a photo, send to `/scan` | capability check fails at startup |

Limit server fallbacks to one request per 2 seconds per device and never send the same crop twice. All thresholds above are guesses, so log them and tune them at the first real event.

## Backend API

One FastAPI service in Python: Pydantic schemas, `sse-starlette` for streaming, one database (SQLite to start, Postgres for a real event). No accounts: the phone sends an anonymous session ID and its bio with each request.

| Endpoint | Job | Called when |
| --- | --- | --- |
| `POST /scan` | Cropped JPEG in, Gemini vision with a JSON schema, fuzzy match against the database, candidates with confidence out | Phone could not match locally |
| `GET /company/{domain}` | Return the cached record, or run enrichment on a miss | Company not in the phone's bundle |
| `POST /chat` | SSE stream: profile + company record + last N messages into Gemini, with Google Search grounding for fresh questions | User taps a card or asks a follow-up |
| `GET /bundle/{event}` | Serve the exhibitor bundle (JSON plus embeddings) | Onboarding |
| `POST /notes` | Save note, interest level, follow-up draft | After the booth, opt-in |

**Enrichment flow (cache miss):** look up by normalized domain; if missing or older than 24 hours, fetch the homepage and about page (Firecrawl or Jina Reader, `httpx` fallback), send the text to Gemini for the structured company record, store it, return it. The phone shows name and logo first, then fills in the summary as it arrives. The warm-up script runs this same function in a loop with limited concurrency.

**Chat rules:** the first message is auto-generated (icebreaker plus two or three talking points) and prefetched when a box locks. Scraped text goes in a delimited block labeled untrusted, and the system prompt says never to follow instructions inside it. Answers are concise and carry source links for news.

**Protections:** per-session limits (about 60 scans and 200 chat messages a day); global daily spend cap with a kill switch; images downscaled on the phone and never stored; robots.txt respected and per-domain scrape rate limits; timeouts that degrade to name, link and a generic profile-based icebreaker instead of an error.

**Deploy:** Docker Compose with `web`, `api` and `db`, behind a CDN with HTTPS. Camera access requires HTTPS.

## Tech stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Frontend | Vue 3, Vite, Pinia, installable PWA | Reactive state for overlays; service worker caches model and exhibitor bundle |
| On-device detection | PaddleOCR-style text detector via ONNX Runtime Web | Runs in a Web Worker; WebGPU where available, WASM otherwise |
| Local data | IndexedDB | Exhibitor bundle plus embeddings, loaded at onboarding |
| Backend | FastAPI (Python only), sse-starlette, Pydantic | Single service; SSE for chat streaming, not WebSockets |
| LLM and vision | Gemini API | Structured output for enrichment and fallback OCR; Google Search grounding for fresh questions |
| Page fetching | Firecrawl or Jina Reader, httpx fallback | Respect robots.txt, rate-limit per domain |
| Database | Postgres (SQLite to start) | companies, sessions, interactions |
| Jobs | FastAPI BackgroundTasks plus a CLI warm-up script | No Celery or RabbitMQ, no Redis |
| Deploy | Docker Compose: web, api, db | Behind CDN and TLS; camera access requires HTTPS |

## Decisions and why

The original spec was rated about 7/10: right instinct on pre-caching, over-built on infrastructure, under-built on recognition and cost. Each row below is a change from it.

| Topic | Original spec | Current decision | Why |
| --- | --- | --- | --- |
| Live OCR | 2 fps frames to Google Cloud Vision | On-device detection in a Web Worker, server only as fallback | 2 fps is about 7,200 calls per user-hour, so cost explodes; conference wifi adds lag; a box from a 700 ms-old frame lands where the banner was |
| Logos | OCR only | Gemini vision fallback for stylized or text-less logos | Plain OCR is weak on odd fonts; Gemini reads logos better |
| Company data | Pre-event CSV pipeline required | Pre-warm optional for coverage, on-demand enrichment plus cache for any company | Without an organizer CSV the original app does nothing |
| Jobs | Celery, RabbitMQ, Redis, Postgres | One FastAPI service, BackgroundTasks, CLI warm script, one database | A few hundred companies do not need a queue |
| Language | FastAPI or Golang | Python only | One choice, less ambiguity |
| Chat transport | WebSockets | SSE | One-way token streaming; simpler |
| Search | Separate Search API via function calling | Gemini Google Search grounding | Built in, returns citations |
| Onboarding | LinkedIn URL | Pasted bio or resume text | LinkedIn blocks scraping and it violates their terms; pasting is faster |
| Matching | Exact cross-reference | Normalize, fuzzy match (rapidfuzz), Gemini disambiguation, candidate chips, manual search | Names like Notion, Apple, Ramp collide with ordinary words |
| Feel | Info card appears on match | Alive interface: lock-on, smoothing, chips, relevance coloring | Priority is a blazingly fast, interactive scan and lookup, not just an open camera |
| After the booth | Not covered | Notes, follow-up drafts, end-of-day contact list | The icebreaker is easy to copy; the follow-up workflow is stickier |

## Data and prompts

**Company record** (one Gemini structured-output call per company, cached by normalized domain, refreshed about every 24 hours; also the shape of the on-device bundle):

```json
{
  "name": "",
  "domain": "",
  "aliases": [],
  "summary": "exactly two sentences",
  "focus_areas": [],
  "products": [],
  "hiring_signals": "",
  "talking_points": [],
  "recent_news": [{"title": "", "url": "", "date": ""}],
  "embedding": [],
  "confidence": 0.0
}
```

**Tables:** `companies` (id, name, domain, aliases, enrichment JSON, fetched\_at); `sessions` (anonymous id, profile hash, created\_at); `interactions` (session\_id, company\_id, notes, interest level, follow-up draft).

**Matching steps:** 1) normalize text (lowercase, strip punctuation and suffixes like Inc.); 2) fuzzy match against the local list with a threshold; 3) if no match, send the top text strings or a cropped frame to Gemini asking which is a company name; 4) if still uncertain, show candidate chips and manual search.

**Chat context:** user profile + company record + last N messages. The first message is auto-generated: an icebreaker plus two or three talking points. Scraped content goes in a delimited block labeled untrusted, and the system prompt says never to follow instructions found in it. Answers stay concise and cite sources for news.

**Relevance coloring:** embed the user's bio once on the device or server, compare against stored exhibitor embeddings, and color boxes green, amber or neutral by similarity.

## Risks and controls

| Risk | Control |
| --- | --- |
| Stylized logos defeat the on-device detector | Server fallback to Gemini vision with a "reading..." shimmer on the box; candidate chips and manual search so no scan dead-ends |
| Battery and heat from continuous inference | Run in bursts, pause on fast motion (blur), drop the frame rate after about 10 seconds without hits |
| Weak devices: older iPhones, no WebGPU | Capability check at startup; fall back to tap-to-scan with server OCR |
| Model download over bad conference wifi (4-10 MB) | Service worker cache; preload while the user types their bio |
| API cost | Per-session limits (for example 60 scans and 200 chat messages a day), global daily spend cap with kill switch, downscaled JPEGs, cache by normalized domain |
| Privacy: frames may show faces | Crop to text regions, tell the model to ignore people, show a notice that photos go to Google for text recognition and are not stored, then actually store nothing |
| Personal data | Profiles stay in the browser unless the user opts into saving notes; Scout is about companies, never attendees |
| Scraping gaps: JS-heavy or bot-blocking sites | Fallback to name, link and a generic profile-based icebreaker; respect robots.txt; per-domain rate limits |
| Prompt injection from scraped pages | Untrusted delimited block, system rule to ignore instructions inside it |
| Generic summaries from marketing pages | Value comes from the "why this fits you" line and pre-generated talking points and news |
| Fake aliveness erodes trust | Idle animation allowed; a detection box only appears for a real detection |
| Commercial model undecided | See open questions |

## Build order and next step

**Immediate next step:** build the camera and overlay layer first as a single Vue or HTML page that opens on a phone, with a simulated detector and a hardcoded company list. Tune lock-on, tracking, chips, relevance coloring and the bottom-sheet card on a real device before wiring any model. If it feels good with fake data, adding the real detector is the easy part; no backend speed fixes a camera that feels dead. This prototype was offered but not yet built.

1. **Prototype:** simulated detector, spring-smoothed boxes, chips, relevance colors, bottom-sheet card, manual search fallback.
2. **Real detection:** ONNX text detector in a Web Worker, local exhibitor bundle in IndexedDB, fuzzy matcher, capability check with tap-to-scan fallback.
3. **Backend:** FastAPI `/scan` (Gemini vision fallback), `/company` (enrichment plus cache), `/chat` (SSE, search grounding), rate limits and spend cap.
4. **Copilot:** speculative icebreaker on lock, streamed chat, notes, follow-up drafts.
5. **Field test:** a real meetup with 10-20 people; watch where scans fail before investing in organizer features.
6. **Later:** warm-up script and exhibitor bundle export, end-of-day contact list, organizer and exhibitor features (lead capture).

**Metrics from day one:** first-try scan success rate versus manual search; time from lock to card; share of chats started from the icebreaker; notes saved and follow-ups drafted per user; cost per active user.

## Defaults to start with

These resolve choices that would otherwise block the first build. Change any of them, but decide before the step that depends on it.

- Anonymous sessions only: no accounts or login. The phone generates a session ID.
- Notes and follow-up drafts stay in the browser (localStorage) in v1. Server-side `/notes` comes later, opt-in.
- SQLite for development, Postgres only for a real event.
- Gemini vision is the only server-side recognition fallback; Cloud Vision is not used unless Gemini proves too slow or costly.
- Hardcode 10-20 sample companies for the prototype; real exhibitor data comes with the warm-up script.
- Matching thresholds from the scan pipeline table (0.85 and 0.60) are starting points to tune.

## First tasks and repo layout

```text
scout/
  web/                 Vue 3 + Vite PWA
    src/camera/        video capture, frame loop, overlay canvas
    src/detect/        Web Worker, ONNX model loader, capability check
    src/match/         normalize + fuzzy matcher, local store (IndexedDB)
    src/ui/            bottom-sheet card, chips, chat view
  api/                 FastAPI service
    routes/            scan.py, company.py, chat.py, bundle.py, notes.py
    services/          gemini.py, enrich.py, fetch.py, match.py, limits.py
    models.py          Pydantic schemas (company record, scan result)
  scripts/warm.py      CSV -> enrichment -> bundle export
  docker-compose.yml   web, api, db
```

- [ ] Prototype page: camera feed, simulated detector, spring-smoothed box, one chip, bottom-sheet card, hardcoded companies
- [ ] Test the prototype on a real phone and tune the lock-on and tracking feel
- [ ] FastAPI skeleton with the five endpoints and the Pydantic company schema
- [ ] Gemini prompts and JSON schemas for scan and enrichment
- [ ] Real detector in a Web Worker, local bundle in IndexedDB, fuzzy matcher
- [ ] Rate limits, spend cap, and the tap-to-scan fallback
- [ ] Field test at a real meetup with 10-20 people

## Open questions

- [ ] Who pays: organizers, exhibitors (lead capture) or attendees?
- [ ] Will organizers supply an exhibitor CSV, and how early before the event?
- [ ] Which on-device detector exactly, and does it meet the 150 ms budget on a mid-range Android and an older iPhone?
- [ ] Is Gemini vision alone good enough for the fallback, or is Cloud Vision still worth keeping as a cheaper second option?
- [ ] Where do embeddings run: on the device or on the server, and how large is the exhibitor bundle at a big event?
- [ ] Should an auto-scan mode (fires only when the image is stable, at most once every 2-3 seconds) ship in the first version?
- [ ] Notes and follow-up drafts: stored server-side with opt-in, or kept only in the browser?
