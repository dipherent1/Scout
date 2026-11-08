<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { FOV_H_DEG, tuning } from '../config'
import { PoseSource } from '../camera/pose'
import { liveStats as hud } from '../camera/stats'
import { drawBooths, drawTrack, drawVenue, RELEVANCE_COLOR, trackPx } from '../camera/overlay'
import { Tracker, type Track } from '../camera/tracker'
import { captureJpeg, useCamera } from '../camera/useCamera'
import type { View } from '../camera/projection'
import { detectCapabilities, type Capabilities } from '../detect/capability'
import { DetectorClient } from '../detect/detector'
import { OcrDetector } from '../detect/ocr'
import { scan, type ScanCandidate } from '../services/api'
import { useScout } from '../stores/scout'
import type { Company, DetectionResult, Pose } from '../types'

const store = useScout()

const root = ref<HTMLDivElement>()
const video = ref<HTMLVideoElement>()
const canvas = ref<HTMLCanvasElement>()
const camera = useCamera()
const pose = markRaw(new PoseSource())

const started = ref(false)
const caps = ref<Capabilities | null>(null)
const tapMode = computed(() => tuning.forceTapToScan || caps.value?.mode === 'tap')
const hasCamera = computed(() => !!camera.stream.value)

/**
 * What the bottom hint card says while no company card is open. Boxes carry no
 * text over the camera; this one card is the only status readout.
 */
const hint = reactive({ mode: 'unknown' as 'unknown' | 'reading' | 'candidate' | 'failed', name: '', trackId: -1 })
let failedUntil = 0
let pointBusy = false

// Tap-to-scan / photo results
const snap = reactive({ busy: false, candidates: [] as ScanCandidate[], message: '' })

let simDetector: DetectorClient | null = null
let ocrDetector: OcrDetector | null = null
/** Real OCR when the camera is live, the simulated venue otherwise (or when forced in tuning). */
const useRealOcr = computed(() => hasCamera.value && !tuning.simulateWithCamera)
let tracker: Tracker | null = null
let raf = 0
let lastFrame = 0
let lastSubmit = 0
let frames = 0
let detCount = 0
let statsAt = 0
let W = 0
let H = 0
let dpr = 1
let currentPose: Pose = { yaw: 0, pitch: 0 }
let focusedId: number | null = null
let focusedSince = 0

function view(): View {
  return { fovH: FOV_H_DEG, aspect: W / Math.max(1, H) }
}

function trackerParams() {
  return {
    lockThreshold: tuning.lockThreshold,
    chipThreshold: tuning.chipThreshold,
    lockHits: tuning.lockHits,
    fallbackStableFrames: tuning.fallbackStableFrames,
    maxMisses: tuning.maxMisses,
    motionCompensation: tuning.motionCompensation,
    springStiffness: tuning.springStiffness,
    springDamping: tuning.springDamping,
  }
}

watch(tuning, () => {
  if (tracker) tracker.params = trackerParams()
  simDetector?.updateSettings({ inferenceMs: tuning.simInferenceMs, noiseDeg: tuning.simNoiseDeg, dropout: tuning.simDropout })
  ocrDetector?.updateSettings({ minConf: tuning.ocrMinConf, maxSide: tuning.ocrMaxSide })
})

function resize() {
  const el = root.value!
  const c = canvas.value!
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  W = el.clientWidth
  H = el.clientHeight
  c.width = Math.round(W * dpr)
  c.height = Math.round(H * dpr)
  simDetector?.updateSettings({ aspect: W / Math.max(1, H) })
}

function buzz(ms: number) {
  if (tuning.haptics) navigator.vibrate?.(ms)
}

function colorFor(c: Company | null): string {
  return c ? RELEVANCE_COLOR[store.relevance(c)] : RELEVANCE_COLOR.neutral
}

async function start() {
  if (started.value) return
  started.value = true
  caps.value = await detectCapabilities()
  // Both permissions must be requested from this tap (iOS requires a user gesture).
  await Promise.all([hasCamera.value ? true : camera.start(video.value!), pose.start(true)])
  tracker = markRaw(new Tracker(store.matcher, trackerParams()))
  if (hasCamera.value) {
    ocrDetector = markRaw(new OcrDetector({ minConf: tuning.ocrMinConf, maxSide: tuning.ocrMaxSide }))
    ocrDetector.onResult = onDetections
  }
  simDetector = markRaw(
    new DetectorClient({
      inferenceMs: tuning.simInferenceMs,
      noiseDeg: tuning.simNoiseDeg,
      dropout: tuning.simDropout,
      fovH: FOV_H_DEG,
      aspect: W / Math.max(1, H),
    }),
  )
  simDetector.onResult = onDetections
  if (hasCamera.value && 'requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    const onVideoFrame = (now: number) => {
      maybeSubmit(now)
      video.value?.requestVideoFrameCallback(onVideoFrame)
    }
    video.value!.requestVideoFrameCallback(onVideoFrame)
  }
  lastFrame = performance.now()
  raf = requestAnimationFrame(loop)
}

function onDetections(r: DetectionResult) {
  if (!tracker) return
  detCount++
  hud.inferMs = hud.inferMs * 0.8 + r.inferenceMs * 0.2
  const ev = tracker.ingest(r, currentPose, view(), performance.now())
  for (const t of ev.locked) onLock(t)
  // Text that matches nothing is never sent anywhere on its own; the user taps it to scan.
}

/** Frame scheduler: target fps, low-power mode after a quiet stretch, pause during fast motion. */
function maybeSubmit(now: number) {
  if (!simDetector || !tracker || tapMode.value) return
  hud.lowPower = now - tracker.lastHitAt > tuning.lowPowerAfterMs
  const fps = hud.lowPower ? tuning.lowPowerFps : tuning.detectFps
  if (now - lastSubmit < 1000 / fps) return
  if (pose.speed > tuning.motionPauseDegPerSec) {
    hud.paused = 'motion'
    return
  }
  if (document.hidden) {
    hud.paused = 'hidden'
    return
  }
  // A card covering the screen means the user is reading, not scanning: stop OCR to save battery.
  if (store.sheet === 'half' || store.sheet === 'full') {
    hud.paused = 'card open'
    return
  }
  hud.paused = ''
  const ok =
    useRealOcr.value && ocrDetector
      ? ocrDetector.submit(currentPose, now, video.value!, W, H)
      : simDetector.submit(currentPose, now)
  if (ok) lastSubmit = now
}

function onLock(t: Track) {
  if (!t.company) return
  buzz(25)
  const c = t.company
  // Start the icebreaker now so it's ready by the time the user taps.
  store.prefetchIcebreaker(c)
  if (store.recentlyDismissed(c)) return
  if (store.sheet === 'hidden' || (store.sheet === 'peek' && t.id === focusedId)) store.select(c, 'scan', 'peek')
}

/** Turn a /scan answer into a company from the local list, or fetch it. */
async function resolveScan(res: Awaited<ReturnType<typeof scan>>): Promise<{ company: Company; confidence: number } | null> {
  const top = res?.candidates[0]
  if (!top || top.confidence < tuning.chipThreshold) return null
  let company = top.domain ? (store.companies.find((c) => c.domain === top.domain) ?? null) : null
  if (!company) company = await store.lookupOnline(top.domain || top.name)
  return company ? { company, confidence: top.confidence } : null
}

/**
 * User tapped a detected box that matched nothing. Send the words read plus a
 * padded crop of that box (so logos work too) to the server.
 */
async function scanTrack(t: Track) {
  if (t.state === 'reading') return
  buzz(10)
  const texts = [...new Set(t.texts.filter((s) => s.replace(/[^a-z0-9]/gi, '').length >= 2))]
  let jpeg: string | undefined
  if (hasCamera.value && video.value) {
    const p = trackPx(t, currentPose, view(), W, H)
    jpeg = captureJpeg(video.value, 768, cropRegion(p.x, p.y, p.w, p.h, 0.25)) ?? undefined
  }
  store.metrics.serverFallbacks++
  t.state = 'reading'
  const hit = await resolveScan(await scan(texts, jpeg))
  if (!hit) {
    t.state = 'unknown'
    failedUntil = performance.now() + 3500
    return
  }
  if (hit.confidence >= tuning.lockThreshold) {
    t.lockTo(hit.company, performance.now())
    onLock(t)
  } else {
    t.state = 'candidates'
    t.candidates = [{ company: hit.company, score: hit.confidence }]
  }
}

/** User tapped empty screen (a logo with no readable text): crop around the finger and send it. */
async function scanPoint(x: number, y: number) {
  if (pointBusy || !hasCamera.value || !video.value) return
  pointBusy = true
  buzz(10)
  const w = W * 0.7
  const h = Math.min(H * 0.35, w)
  const jpeg = captureJpeg(video.value, 768, cropRegion(x - w / 2, y - h / 2, w, h, 0))
  store.metrics.serverFallbacks++
  const hit = jpeg ? await resolveScan(await scan([], jpeg)) : null
  pointBusy = false
  if (!hit) {
    failedUntil = performance.now() + 3500
    return
  }
  buzz(25)
  store.prefetchIcebreaker(hit.company)
  store.select(hit.company, 'chip', 'peek')
}

/** Screen rect (px, object-fit: cover), padded by a fraction on each side -> normalized video region. */
function cropRegion(px: number, py: number, pw: number, ph: number, pad: number) {
  const v = video.value!
  const cover = Math.max(W / v.videoWidth, H / v.videoHeight)
  const ox = (v.videoWidth - W / cover) / 2
  const oy = (v.videoHeight - H / cover) / 2
  const x0 = Math.max(0, ox + (px - pw * pad) / cover)
  const y0 = Math.max(0, oy + (py - ph * pad) / cover)
  return {
    x: x0 / v.videoWidth,
    y: y0 / v.videoHeight,
    w: (pw * (1 + 2 * pad)) / cover / v.videoWidth,
    h: (ph * (1 + 2 * pad)) / cover / v.videoHeight,
  }
}

function openHint() {
  const t = tracker?.tracks.find((x) => x.id === hint.trackId)
  const m = t?.candidates[0]
  if (!t || !m) return
  t.lockTo(m.company, performance.now(), true)
  buzz(15)
  store.select(m.company, 'chip', 'half')
}

function loop(now: number) {
  raf = requestAnimationFrame(loop)
  const dt = now - lastFrame
  lastFrame = now
  frames++
  currentPose = pose.read(now)
  if (!hasCamera.value || !caps.value?.videoFrameCallback) maybeSubmit(now)
  tracker?.animate(dt)
  render(now)
  if (now - statsAt > 500) {
    hud.fps = Math.round((frames * 1000) / (now - statsAt))
    hud.detFps = Math.round((detCount * 1000) / (now - statsAt))
    hud.tracks = tracker?.tracks.length ?? 0
    hud.cameraError = camera.error.value ?? ''
    hud.sensor = pose.hasSensor ? 'gyro' : 'drag'
    hud.detector = useRealOcr.value ? (ocrDetector?.backend ?? '') : 'simulated'
    frames = 0
    detCount = 0
    statsAt = now
  }
}

function render(now: number) {
  const c = canvas.value
  if (!c || !tracker) return
  const ctx = c.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, H)
  const v = view()
  if (!hasCamera.value) drawVenue(ctx, currentPose, v, W, H)
  if (!useRealOcr.value) drawBooths(ctx, currentPose, v, W, H, hasCamera.value)

  // Focus = the locked box nearest the center; drives the dwell cue and which card is shown.
  let focus: Track | null = null
  let bestD = 0.3
  const pxById = new Map<number, ReturnType<typeof trackPx>>()
  for (const t of tracker.tracks) {
    const p = trackPx(t, currentPose, v, W, H)
    pxById.set(t.id, p)
    if (t.state !== 'locked' || t.dying) continue
    const d = Math.hypot((p.x + p.w / 2) / W - 0.5, (p.y + p.h / 2) / H - 0.45)
    if (d < bestD) {
      bestD = d
      focus = t
    }
  }
  if ((focus?.id ?? null) !== focusedId) {
    focusedId = focus?.id ?? null
    focusedSince = now
    if (focus?.company && (store.sheet === 'peek' || store.sheet === 'hidden') && !store.recentlyDismissed(focus.company)) {
      if (store.selected !== focus.company) store.select(focus.company, 'scan', 'peek')
    }
  }
  let dwell: number | null = null
  if (focus?.company && store.selected === focus.company && store.sheet === 'peek') {
    dwell = Math.min(1, (now - focusedSince) / tuning.dwellMs)
    if (dwell >= 1) store.setSheet('half')
  }

  let cand: Track | null = null
  let candD = 0.5
  let reading = pointBusy
  for (const t of tracker.tracks) {
    const p = pxById.get(t.id)!
    drawTrack(ctx, t, p, { now, color: colorFor(t.company), dwell: t === focus ? dwell : null })
    if (t.dying) continue
    if (t.state === 'reading') reading = true
    if (t.state === 'candidates' && t.candidates.length) {
      const d = Math.hypot((p.x + p.w / 2) / W - 0.5, (p.y + p.h / 2) / H - 0.45)
      if (d < candD) {
        candD = d
        cand = t
      }
    }
  }
  const mode = reading ? 'reading' : cand ? 'candidate' : now < failedUntil ? 'failed' : 'unknown'
  const name = cand ? cand.candidates[0].company.name : ''
  const trackId = cand ? cand.id : -1
  if (hint.mode !== mode) hint.mode = mode
  if (hint.name !== name) hint.name = name
  if (hint.trackId !== trackId) hint.trackId = trackId
}

// ---- Interaction ----
let down: { x: number; y: number; moved: boolean; held: boolean } | null = null

const HOLD_MS = 450
let holdTimer = 0
/** Where a press is being held, for the progress ring. */
const press = reactive({ on: false, x: 0, y: 0 })

function cancelHold() {
  clearTimeout(holdTimer)
  press.on = false
}

function onPointerDown(e: PointerEvent) {
  down = { x: e.clientX, y: e.clientY, moved: false, held: false }
  ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  const rect = root.value!.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  press.x = x
  press.y = y
  press.on = true
  clearTimeout(holdTimer)
  holdTimer = window.setTimeout(() => {
    if (!down || down.moved) return
    down.held = true
    press.on = false
    holdScan(x, y)
  }, HOLD_MS)
}
function onPointerMove(e: PointerEvent) {
  if (!down) return
  const dx = e.clientX - down.x
  const dy = e.clientY - down.y
  if (!down.moved && Math.hypot(dx, dy) < 6) return
  down.moved = true
  cancelHold()
  const v = view()
  pose.addDrag((-dx / W) * v.fovH, (dy / H) * (v.fovH / v.aspect))
  down.x = e.clientX
  down.y = e.clientY
}

const near = (t: Track, x: number, y: number) => {
  const p = trackPx(t, currentPose, view(), W, H)
  return x >= p.x - 12 && x <= p.x + p.w + 12 && y >= p.y - 12 && y <= p.y + p.h + 12
}

/** Press and hold: crop around the box (or the finger) and send it to the server. */
function holdScan(x: number, y: number) {
  if (!tracker) return
  const t = tracker.tracks.find((t) => !t.dying && t.state !== 'locked' && t.state !== 'reading' && near(t, x, y))
  if (t) void scanTrack(t)
  else if (tapMode.value && !hasCamera.value) tapScan()
  else void scanPoint(x, y)
}

/** A quick tap only opens things Scout already recognized. */
function onPointerUp(e: PointerEvent) {
  cancelHold()
  const wasTap = down && !down.moved && !down.held
  down = null
  if (!wasTap || !tracker) return
  const rect = root.value!.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  for (const t of tracker.tracks) {
    if (t.dying || !near(t, x, y)) continue
    if (t.state === 'locked' && t.company) {
      store.select(t.company, 'scan', 'half')
      return
    }
    if (t.state === 'candidates' && t.candidates[0]) {
      t.lockTo(t.candidates[0].company, performance.now(), true)
      buzz(15)
      store.select(t.candidates[0].company, 'chip', 'half')
      return
    }
  }
}

function onKey(e: KeyboardEvent) {
  if ((e.target as HTMLElement)?.closest('input, textarea')) return
  const step = e.shiftKey ? 8 : 3
  if (e.key === 'ArrowLeft') pose.addDrag(-step, 0)
  else if (e.key === 'ArrowRight') pose.addDrag(step, 0)
  else if (e.key === 'ArrowUp') pose.addDrag(0, step)
  else if (e.key === 'ArrowDown') pose.addDrag(0, -step)
  else return
  e.preventDefault()
}

/** Tap-to-scan mode: run one detection on the current frame. */
function tapScan() {
  buzz(10)
  if (useRealOcr.value && ocrDetector) ocrDetector.submit(currentPose, performance.now(), video.value!, W, H)
  else simDetector?.submit(currentPose, performance.now())
}

/** Real photo -> POST /scan (Gemini vision). This is the path weak devices use, and it works on real booths today. */
async function snapPhoto() {
  if (!video.value || snap.busy) return
  const jpeg = captureJpeg(video.value, 768)
  if (!jpeg) return
  buzz(10)
  snap.busy = true
  snap.message = ''
  snap.candidates = []
  const res = await scan([], jpeg)
  snap.busy = false
  if (!res) snap.message = store.apiStatus === 'online' ? 'Could not read that. Try again or search.' : 'Server offline. Use search.'
  else if (!res.candidates.length) snap.message = 'No company found in that photo.'
  else snap.candidates = res.candidates.slice(0, 3)
}

async function pickSnap(c: ScanCandidate) {
  snap.candidates = []
  let company = store.companies.find((x) => x.domain === c.domain) ?? null
  if (!company) {
    snap.message = `Looking up ${c.name}…`
    company = await store.lookupOnline(c.domain || c.name)
    snap.message = company ? '' : `Couldn't load ${c.name}.`
  }
  if (company) store.select(company, 'chip', 'half')
}

function recenter() {
  pose.recenter()
}

onMounted(() => {
  resize()
  window.addEventListener('resize', resize)
  window.addEventListener('keydown', onKey)
  // Show the live camera behind the start screen. Phones that need a gesture simply stay dark until the tap.
  void camera.start(video.value!)
})
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  clearTimeout(holdTimer)
  window.removeEventListener('resize', resize)
  window.removeEventListener('keydown', onKey)
  simDetector?.dispose()
  ocrDetector?.dispose()
  camera.stop()
  pose.stop()
})

defineExpose({ recenter })
</script>

<template>
  <div
    ref="root"
    class="scan"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @contextmenu.prevent
  >
    <video ref="video" class="feed" playsinline muted autoplay />
    <canvas ref="canvas" class="overlay" />

    <div v-if="press.on" class="ring" :style="{ left: press.x + 'px', top: press.y + 'px', animationDuration: HOLD_MS + 'ms' }" />

    <div v-if="started && store.sheet === 'hidden'" class="hintcard" @pointerdown.stop @pointerup.stop>
      <button v-if="hint.mode === 'candidate'" class="hint-main" @click="openHint">
        <strong>{{ hint.name }}?</strong>
        <small>Tap to open</small>
      </button>
      <div v-else-if="hint.mode === 'reading'" class="hint-main static">
        <span class="spinner" /><strong>Reading…</strong>
      </div>
      <div v-else class="hint-main static">
        <strong>{{ hint.mode === 'failed' ? 'Still unknown' : 'Unknown' }}</strong>
        <small>{{ hint.mode === 'failed' ? 'Move closer and hold the name or logo again' : 'Press and hold the name or logo on the screen' }}</small>
      </div>
    </div>

    <div v-if="!started" class="start" @pointerdown.stop @pointerup.stop @click="start">
      <div class="start-card">
        <svg class="finder" viewBox="0 0 80 80" width="84" height="84"><path fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" d="M8 28V12a4 4 0 0 1 4-4h16M52 8h16a4 4 0 0 1 4 4v16M72 52v16a4 4 0 0 1-4 4H52M28 72H12a4 4 0 0 1-4-4V52"/><circle cx="40" cy="40" r="4" fill="currentColor"/></svg>
        <h1>Point. Scout does the rest.</h1>
        <p>Aim at a booth banner. Tap anywhere to begin.</p>
        <p class="fine">Text is read on your device. Photos you snap go to Google for text recognition and are not stored.</p>
      </div>
    </div>

    <div v-if="started" class="controls" @pointerdown.stop @pointerup.stop>
      <button v-if="hasCamera" class="round" :disabled="snap.busy" title="Snap a photo and read it on the server" @click="snapPhoto">
        <span v-if="snap.busy" class="spinner" />
        <svg v-else viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M9 4 7.2 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3.2L15 4H9Zm3 4.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Zm0 2a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z"/></svg>
      </button>
      <button v-if="tapMode" class="round shutter" title="Tap to scan" @click="tapScan" />
      <button class="round" title="Recenter" @click="recenter">
        <svg viewBox="0 0 24 24" width="20" height="20"><path fill="none" stroke="currentColor" stroke-width="2" d="M12 3v3m0 12v3M3 12h3m12 0h3"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/></svg>
      </button>
    </div>

    <div v-if="snap.candidates.length || snap.message" class="snap" @pointerdown.stop @pointerup.stop>
      <template v-if="snap.candidates.length">
        <span class="hint">From photo</span>
        <button v-for="c in snap.candidates" :key="c.domain + c.name" class="chip" @click="pickSnap(c)">
          {{ c.name }} <small>{{ Math.round(c.confidence * 100) }}%</small>
        </button>
      </template>
      <span v-else class="hint">{{ snap.message }}</span>
      <button class="chip ghost" @click="snap.candidates = []; snap.message = ''">✕</button>
    </div>

  </div>
</template>

<style scoped>
.scan {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: #0b0d10;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
.feed,
.overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.feed {
  object-fit: cover;
}
.labels {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.label {
  position: absolute;
  left: 0;
  top: 0;
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: nowrap;
  pointer-events: auto;
  will-change: transform;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 11px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(17, 20, 26, 0.78);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  color: #f9fafb;
  font: 600 13px/1 system-ui, sans-serif;
  white-space: nowrap;
  cursor: pointer;
  animation: pop 0.22s cubic-bezier(0.3, 1.6, 0.5, 1);
}
.chip small {
  opacity: 0.6;
  font-weight: 500;
}
.chip.locked {
  border-color: var(--c);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--c) 40%, transparent), 0 4px 16px rgba(0, 0, 0, 0.35);
}
.chip .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--c);
}
.chip.ghost {
  background: rgba(17, 20, 26, 0.55);
  color: #d1d5db;
}
.chip.reading {
  color: #e5e7eb;
  font-weight: 500;
}
.hint {
  font: 500 12px system-ui, sans-serif;
  color: #e5e7eb;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.8);
  white-space: nowrap;
}
@keyframes pop {
  from {
    transform: scale(0.6);
    opacity: 0;
  }
}
.start {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: linear-gradient(180deg, rgba(8, 11, 16, 0.2), rgba(8, 11, 16, 0.55));
  padding: 24px;
  cursor: pointer;
}
.start-card {
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.6);
}
.finder {
  color: #5eead4;
  animation: breathe 2.4s ease-in-out infinite;
}
@keyframes breathe {
  50% {
    transform: scale(1.1);
    opacity: 0.7;
  }
}
.start-card {
  max-width: 340px;
  text-align: center;
  color: #e5e7eb;
}
.start-card h1 {
  font: 800 28px system-ui, sans-serif;
  letter-spacing: -0.02em;
  margin: 12px 0 8px;
  color: #5eead4;
}
.start-card p {
  line-height: 1.45;
  color: #cbd5e1;
}
.start-card .fine {
  font-size: 12px;
  color: #94a3b8;
  margin-top: 18px;
}
.primary {
  margin-top: 12px;
  padding: 14px 26px;
  border-radius: 999px;
  border: 0;
  background: #5eead4;
  color: #042f2e;
  font: 700 16px system-ui, sans-serif;
  cursor: pointer;
}
.ring {
  position: absolute;
  width: 64px;
  height: 64px;
  margin: -32px 0 0 -32px;
  border-radius: 50%;
  border: 3px solid #5eead4;
  pointer-events: none;
  z-index: 15;
  animation: hold linear forwards;
}
@keyframes hold {
  from {
    transform: scale(1.6);
    opacity: 0.2;
  }
  to {
    transform: scale(0.8);
    opacity: 1;
  }
}
.hintcard {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: calc(env(safe-area-inset-bottom) + 14px);
  z-index: 20;
}
.hint-main {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 14px 18px;
  border-radius: 18px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(17, 20, 26, 0.82);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: #f9fafb;
  font: inherit;
  text-align: left;
}
button.hint-main {
  cursor: pointer;
  border-color: rgba(94, 234, 212, 0.5);
}
.hint-main strong {
  font: 700 17px system-ui, sans-serif;
}
.hint-main small {
  color: #94a3b8;
  font: 500 13px system-ui, sans-serif;
  text-align: right;
  min-width: 0;
}
.hint-main strong {
  flex: none;
}
.controls {
  position: absolute;
  right: 14px;
  bottom: calc(env(safe-area-inset-bottom) + 120px);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.round {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(17, 20, 26, 0.7);
  backdrop-filter: blur(10px);
  color: #f9fafb;
  display: grid;
  place-items: center;
  cursor: pointer;
}
.round.shutter {
  width: 64px;
  height: 64px;
  background: #f9fafb;
  border: 5px solid rgba(255, 255, 255, 0.35);
  background-clip: padding-box;
}
.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.snap {
  position: absolute;
  left: 12px;
  right: 72px;
  bottom: calc(env(safe-area-inset-bottom) + 124px);
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.hud {
  position: absolute;
  left: 8px;
  top: calc(env(safe-area-inset-top) + 64px);
  display: flex;
  flex-direction: column;
  gap: 2px;
  font: 500 10px ui-monospace, monospace;
  color: rgba(255, 255, 255, 0.75);
  text-shadow: 0 1px 2px #000;
  pointer-events: none;
}
.hud .warn {
  color: #fca5a5;
}
</style>
