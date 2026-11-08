# Scout: project log

What has been built so far, how it behaves, what was decided and why, and what is left. Design intent lives in [scout.md](../scout.md); how to run it lives in the [README](../README.md). This file is the history and the current state. Last updated 8 Nov 2026.

## 1. Where the project stands

| Area | State |
| --- | --- |
| Phone app (Vue 3 PWA) | Built. Live camera, on-device text reading, tracker, bottom card, copilot chat, notes, follow-ups, contact list |
| Text detection | Working, but with Tesseract.js (slow, about 1 s per frame on a laptop), not the planned ONNX model (step 2 of `scout.md`) |
| Backend (FastAPI) | Built. `/scan`, `/company`, `/chat` (SSE), `/bundle`, `/notes`, rate limits, spend cap |
| Copilot (Gemini) | Built and tested live. News answers with Google Search need a billing-enabled key |
| Warm-up script | Built (`scripts/warm.py`), tested on 5 companies |
| Docker Compose | Written, **never run** |
| Real-phone test | Started by the user on a phone. Scanning a laptop screen showing "stripe" produced boxes and a lock |
| Field test (step 5) | Not done |

Checks at the last run: type check clean, 17 web tests pass, production build passes, 14 API tests pass.

## 2. Timeline

1. **Read the design.** The user asked for `scout.md` to be read, then implemented. Build order followed: prototype first, then backend and copilot, then the warm-up script and Docker.
2. **Prototype with a simulated detector.** A Web Worker "reads" 12 simulated banners placed around the user (turn the phone or drag). It adds latency, jitter, dropped frames, OCR misreads and clipped text, and never invents text that is not in the scene. Used to tune lock-on, chips, colors and the card before any model existed.
3. **Backend and copilot.** FastAPI service, Gemini scan/enrichment/chat, per-session limits, spend cap, robots.txt-respecting fetching, template fallbacks. Tested against live Gemini.
4. **Phone access.** The user could not reach the dev server from a phone. Cause: the PC was on a "Guest" Wi-Fi that isolates devices. Fixed by switching networks. Troubleshooting is in the README. The PC's address changes when it reconnects, so use the IPv4 shown under the Wi-Fi adapter in `ipconfig`, with port 5174 and `https://`.
5. **Real text instead of the simulation.** With the camera on, the simulated banners are off and Tesseract.js reads real frames. Tesseract's default settings missed dark text on a white sign against grey, so it alternates two thresholding modes per frame and the tracker merges hits.
6. **Knowledge graph.** Graphify was run over the repo (483 nodes, 823 edges, 30 communities) into `graphify-out/` (git-ignored). It does not follow calls inside Vue files or through the Pinia store, so the scan view to card path is missing from it.
7. **UI rework after the first phone test.** No bio screen at the start, a translucent start screen over the live camera, detection stats moved to the settings panel, OCR paused while a card is open, and "Did you mean" chips removed in favor of one bottom card.
8. **Press and hold to scan** (this commit). See section 4.

## 3. How it works now

### On the phone (no network)

The scan loop in [ScanView.vue](../web/src/ui/ScanView.vue) runs while the camera is live:

1. `useCamera` plays the rear camera in a `<video>`. The camera starts when the page loads, so the start screen sits over the live picture. Phones that need a gesture stay dark until the first tap.
2. `maybeSubmit` samples a frame about 8 times a second. It slows to 3 fps after 10 s without a hit and pauses during fast motion, when the tab is hidden, and while a card is half or fully open.
3. [OcrDetector](../web/src/detect/ocr.ts) crops the frame to what is on screen and runs Tesseract in a worker. Result: boxes, words, confidence, tagged with the device pose at capture time.
4. [Tracker](../web/src/camera/tracker.ts) associates boxes across frames, smooths them with springs at 60 fps, compensates for phone movement using the gyroscope, and runs a 5-frame vote per box.
5. [Matcher](../web/src/match/matcher.ts) normalizes the text (lowercase, accents, punctuation, legal suffixes, OCR confusions such as 1 for l or i) and fuzzy-matches it against the company list stored on the phone.

| Top match score | What happens |
| --- | --- |
| 0.85 or more, seen twice | Box locks (green bracket), phone buzzes, card peeks up from local data, icebreaker starts streaming |
| 0.60 to 0.85 | Dashed box; bottom card says the name with a question mark ("Stripe?"), tap to open |
| Below 0.60 | Faint box only. Nothing is sent anywhere |

Common-word names (Apple, Stripe, Ramp...) are capped at 0.78 when they only appear inside a longer string, so "APPLE PIE STAND" never locks onto Apple.

### Bottom card

Shown only when no company card is open.

- **Unknown**: "Press and hold the name or logo on the screen".
- **Reading…**: a server lookup is running.
- **Still unknown**: the last lookup found nothing; shown for a few seconds with advice to move closer.
- **Name?**: a possible local match; tap to open.
- A confident match uses the normal peek card instead.

### Press and hold

Implemented in `onPointerDown` / `holdScan` in `ScanView.vue`.

- Holding for 450 ms on a box that matched nothing crops that box with 25% padding and sends the crop and the words read to `POST /scan`.
- Holding on empty screen crops a wide patch around the finger. This covers logos with no readable text.
- A ring animates around the finger during the hold. Moving the finger cancels the hold and drags the view.
- A quick tap only opens a box Scout already recognized (locked, or a "Name?" candidate). It never calls the server.
- Nothing is ever sent to the server automatically.

### When the phone calls the server

| When | Call | Purpose |
| --- | --- | --- |
| App opens | `GET /health`, `GET /bundle/{event}` | Check the server, download the company list |
| A box locks | `POST /chat` (icebreaker) | Start the icebreaker before the user looks |
| Press and hold | `POST /scan` (words + crop) | Gemini picks the company; `GET /company/{name}` fetches and caches it |
| Camera button | `POST /scan` (whole frame) | Same, for the full view |
| Search or "Look up online" | `GET /company/{name}` | Cached record, or enrichment (about 5 s) |
| Question or "Draft follow-up" | `POST /chat` | Streamed answer with profile, company and last 10 messages |

`POST /notes` exists but the app does not call it: notes, interest and follow-ups stay in localStorage.

If the server is down, scanning, locking and cards keep working from the phone's list; chat falls back to template text built from the company record.

### Backend

FastAPI in [api/](../api/). SQLite by default, Postgres via `DATABASE_URL`. Gemini defaults: chat on `gemini-3.5-flash` with minimal thinking (first token in about 1 s), scan and enrichment on `gemini-3.5-flash-lite`. Chat retries on the fast model, then retries without search (with an instruction not to claim recent news), then returns a template. Scraped text goes to the model inside an untrusted block with a rule to ignore instructions in it. Limits: about 60 scans and 200 chat messages per session per day, a global daily spend cap and kill switch, one fetch per domain at a time, robots.txt respected, private addresses blocked.

## 4. What changed in the latest commit

- **Press and hold to scan** replaces tap-to-scan, with a progress ring. Tap now only opens recognized things.
- **Camera starts on page load** behind a translucent start screen.
- **No chips over the camera.** A bottom card is the only status readout. Boxes are kept.
- **Crop-and-send:** hold sends a crop, not only text, so logos work.
- **Detection stats** moved from the camera view to a "Detection (live)" section in the settings panel.
- **OCR pauses** while a card is half or fully open (saves battery); resumes on close or peek.
- **No bio gate.** The bio can still be set under settings, "Edit bio". Without one, fit colors stay neutral and icebreakers are generic.
- **Real OCR** (`web/src/detect/ocr.ts`) with Tesseract.js; simulated venue only when there is no camera or when forced in settings.
- Removed settings that no longer apply (automatic server call interval).
- New [docs/PROJECT_LOG.md](PROJECT_LOG.md) (this file).

## 5. Decisions and why

| Decision | Why |
| --- | --- |
| Simulated detector first | `scout.md`: tune feel before any model. It also gave a protocol the real detector reuses |
| Tesseract.js as the stand-in detector | Runs today with no model conversion; good for printed signs. It is too slow for the 150 ms budget and weak on stylized logos |
| Alternate thresholding per frame | One setting misses light-on-dark, the other misses dark-on-light; the tracker merges both |
| Nothing leaves the phone without a user action | Cost, privacy, and the earlier automatic fallback fired on noise text |
| Press and hold instead of tap | Prevents accidental server calls and keeps quick taps for opening cards |
| Bottom card instead of chips | Chips covered the view and the camera should stay clear |
| Bag-of-words relevance instead of embeddings | Good enough to color boxes; real embeddings are an open question in `scout.md` |
| Notes in localStorage | The default in `scout.md` for v1; `/notes` is ready for opt-in sync |
| TypeScript pinned to 5.9 | TypeScript 7 breaks the Vue type checker |

## 6. Known gaps versus scout.md

- Detector is Tesseract, not a PaddleOCR-style ONNX model with WebGPU/WASM; the 150 ms budget is not met.
- The OCR engine and English model download from a CDN on first use; the service worker does not cache them.
- Relevance coloring is word overlap, not embeddings.
- Google Search grounding needs billing on the Gemini key.
- Docker Compose is untested.
- No field test yet (step 5).
- Estimated field of view (52 degrees) is not calibrated per phone, so boxes may drift slightly when turning.
- Graphify reports a false import cycle between `api/main.py` and `api/services/limits.py`.

## 7. Next

1. Test press and hold on the phone; tune `HOLD_MS`, the crop sizes and the OCR confidence in the settings panel.
2. Step 2 of `scout.md`: ONNX text detector in the worker, model cached offline by the service worker and preloaded while the user types a bio.
3. Run the Docker stack once.
4. Field test with 10 to 20 people; watch first-try scan success against manual search and lock-to-card time (the settings panel already records them).
5. Turn on Gemini billing if live news answers matter.
