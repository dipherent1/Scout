# Scout

Camera-first networking copilot for events. Point a phone at a booth, get a summary, a "why this fits you" line and a streamed icebreaker. Design and decisions: [scout.md](scout.md).

This repo implements **build step 1 (prototype)** in full, plus working versions of steps 3-4 (backend and copilot). Step 2 (real on-device ONNX detector) is not done: the scan loop runs a **simulated detector** in a Web Worker that speaks the same protocol the ONNX detector will.

## Run it

You need Node 20+ and [uv](https://docs.astral.sh/uv/). Put `GEMINI_API_KEY=...` in `.env` at the repo root (see `.env.example`). Without a key everything still works; chat falls back to templates built from the company record.

```bash
cd api && uv sync && uv run uvicorn main:app --reload --port 8000
```

```bash
cd web && npm install && npm run dev
```

Open the `https://` URL Vite prints. **On a phone**, use the network URL (for example `https://192.168.1.20:5173`) on the same Wi-Fi and accept the self-signed certificate warning once; camera and gyroscope need HTTPS. On a laptop, drag the scene or use the arrow keys to look around.

If the phone can't connect:

- Use the address labelled **Wi-Fi**. Vite also lists WSL and VMware adapters (`172.23.x`, `192.168.18x.x`), and the phone can't reach those.
- Use `https://`. The `SCOUT_HTTP=1` mode is plain HTTP, so phone browsers block the camera.
- Guest, campus and venue Wi-Fi often block devices from reaching each other. Turn on the phone's hotspot, join it from the PC, and use the new Wi-Fi address. A tunnel such as `cloudflared tunnel --url https://localhost:5173 --no-tls-verify` also works.
- On Windows, allow Node.js through the firewall for the network profile you're on (Public or Private).

Tests: `cd web && npm test` and `cd api && uv run pytest`.

## What to try

Simulated banners are placed around you (turn left and right). Each one exercises a different path:

| Banner | What should happen |
| --- | --- |
| stripe, DATADOG, supabase, Hugging Face, Linear, Vercel | Box springs on, haptic buzz, card peeks up. Hold for 2 s and the card expands (dwell ring) |
| CLOUDFLARE (italic), MongoDB | OCR garbles them: "Did you mean" chips |
| APPLE PIE STAND | Common-word collision: a chip, never a lock |
| NOVA ROBOTICS | Not in the bundle: "reading…" shimmer, server fallback, then "Not recognized · Search" |
| FREE COFFEE, BOOTH 14 | Faint text boxes only |

The search bar is always there, and "Look up online" enriches any company on demand. The camera button sends a real photo to Gemini vision, which is the tap-to-scan fallback, and it already works on real booths. The tuning panel (sliders icon) exposes every threshold, spring constant and detector parameter live, plus the day-one metrics.

## Layout

```text
web/                 Vue 3 + Vite PWA
  src/camera/        pose (gyro/drag), projection, tracker (springs, voting, motion compensation), overlay drawing
  src/detect/        detector worker (simulated), protocol, scene, capability check
  src/match/         normalize, fuzzy matcher, hashed-embedding relevance, IndexedDB bundle store
  src/ui/            scan view, bottom sheet + chat, search, onboarding, tuning, contacts
api/                 FastAPI
  routes/            scan, company, chat (SSE), bundle, notes
  services/          gemini, enrich, fetch, match, limits
scripts/warm.py      CSV -> enrichment -> data/bundles/<event>.json
data/                sample companies (shared by web and api), example exhibitor CSV
docker-compose.yml   web (nginx), api, db (Postgres)
```

## Notes and known gaps

- **Search grounding** needs a billing-enabled Gemini key. Without one, grounded questions retry without search and are told not to claim recent news.
- **Models** default to `gemini-3.5-flash` with minimal thinking for chat (about 1 s to first token) and `gemini-3.5-flash-lite` for scan and enrichment. On failure, chat retries on the fast model, then falls back to a template.
- **Relevance coloring** uses a hashed bag-of-words with synonyms on the device. It stands in for real embeddings (an open question in scout.md).
- **Rate limits and spend** are tracked in memory per API process. Spend is estimated from token usage at the prices set in `.env`.
- **Notes** stay in localStorage in v1. `POST /notes` exists for a later opt-in sync, but the web app does not call it yet.
- **Next (step 2):** replace `detect/sim.worker.ts` with an ONNX Runtime Web text detector and recognizer. `DetectorClient.submit` already accepts an `ImageBitmap`, and the tracker and matcher stay as they are.
