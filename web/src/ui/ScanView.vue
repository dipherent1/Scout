<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { FOV_H_DEG, tuning } from '../config'
import { PoseSource } from '../camera/pose'
import { drawBooths, drawTrack, drawVenue, RELEVANCE_COLOR, trackPx } from '../camera/overlay'
import { Tracker, type Track } from '../camera/tracker'
import { captureJpeg, useCamera } from '../camera/useCamera'
import type { View } from '../camera/projection'
import { detectCapabilities, type Capabilities } from '../detect/capability'
import { DetectorClient } from '../detect/detector'
import { normalize } from '../match/normalize'
import { scan, type ScanCandidate } from '../services/api'
import { useScout } from '../stores/scout'
import type { Company, MatchResult, Pose } from '../types'

const emit = defineEmits<{ search: [query: string] }>()
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

const hud = reactive({ fps: 0, detFps: 0, inferMs: 0, tracks: 0, paused: '' as string, lowPower: false })

// Labels and chips rendered as DOM so they are tappable.
interface Label {
  id: number
  x: number
  y: number
  w: number
  state: Track['state']
  company: Company | null
  color: string
  candidates: MatchResult[]
  text: string
}
const labels = ref<Label[]>([])

// Tap-to-scan / photo results
const snap = reactive({ busy: false, candidates: [] as ScanCandidate[], message: '' })

let detector: DetectorClient | null = null
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
let lastFallbackAt = 0
const sentFallbackKeys = new Set<string>()

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
  detector?.updateSettings({ inferenceMs: tuning.simInferenceMs, noiseDeg: tuning.simNoiseDeg, dropout: tuning.simDropout })
})

function resize() {
  const el = root.value!
  const c = canvas.value!
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  W = el.clientWidth
  H = el.clientHeight
  c.width = Math.round(W * dpr)
  c.height = Math.round(H * dpr)
  detector?.updateSettings({ aspect: W / Math.max(1, H) })
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
  await Promise.all([camera.start(video.value!), pose.start(true)])
  tracker = markRaw(new Tracker(store.matcher, trackerParams()))
  detector = markRaw(
    new DetectorClient({
      inferenceMs: tuning.simInferenceMs,
      noiseDeg: tuning.simNoiseDeg,
      dropout: tuning.simDropout,
      fovH: FOV_H_DEG,
      aspect: W / Math.max(1, H),
    }),
  )
  detector.onResult = (r) => {
    if (!tracker) return
    detCount++
    hud.inferMs = hud.inferMs * 0.8 + r.inferenceMs * 0.2
    const ev = tracker.ingest(r, currentPose, view(), performance.now())
    for (const t of ev.locked) onLock(t)
    for (const t of ev.needsFallback) void serverFallback(t)
  }
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

/** Frame scheduler: target fps, low-power mode after a quiet stretch, pause during fast motion. */
function maybeSubmit(now: number) {
  if (!detector || !tracker || tapMode.value) return
  hud.lowPower = now - tracker.lastHitAt > tuning.lowPowerAfterMs
  const fps = hud.lowPower ? tuning.lowPowerFps : tuning.detectFps
  if (now - lastSubmit < 1000 / fps) return
  if (pose.speed > tuning.motionPauseDegPerSec) {
    hud.paused = 'motion'
    return
  }
  hud.paused = document.hidden ? 'hidden' : ''
  if (document.hidden) return
  // The simulated detector does not need pixels; the ONNX detector will receive
  // an ImageBitmap of the video frame here (createImageBitmap(video)).
  if (detector.submit(currentPose, now)) lastSubmit = now
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

/** Text is visible and stable but matches nothing locally: ask the server (rate-limited, no repeats). */
async function serverFallback(t: Track) {
  const texts = [...new Set(t.texts.filter((s) => s.replace(/[^a-z0-9]/gi, '').length >= 3))]
  const key = normalize(texts.join(' | '))
  const now = performance.now()
  if (!key || sentFallbackKeys.has(key) || now - lastFallbackAt < tuning.fallbackMinIntervalMs) {
    t.fallbackRequested = false
    t.stableNoMatch = 0
    return
  }
  sentFallbackKeys.add(key)
  lastFallbackAt = now
  store.metrics.serverFallbacks++
  t.state = 'reading'
  console.info('[scout] server fallback', texts)
  const res = await scan(texts)
  const top = res?.candidates[0]
  if (!top || top.confidence < tuning.chipThreshold) {
    // Readable text that is not a company (or the server is offline): keep the
    // faint box, never ask again for it. Manual search stays in the top bar.
    t.state = 'text'
    return
  }
  let company = top.domain ? (store.companies.find((c) => c.domain === top.domain) ?? null) : null
  if (!company) company = await store.lookupOnline(top.domain || top.name)
  if (!company) {
    t.state = 'unknown'
    return
  }
  if (top.confidence >= tuning.lockThreshold) {
    t.lockTo(company, performance.now())
    onLock(t)
  } else {
    t.state = 'candidates'
    t.candidates = [{ company, score: top.confidence }]
  }
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
  if (tuning.showSimScene || !hasCamera.value) drawBooths(ctx, currentPose, v, W, H, hasCamera.value)

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

  const next: Label[] = []
  for (const t of tracker.tracks) {
    const p = pxById.get(t.id)!
    const color = colorFor(t.company)
    drawTrack(ctx, t, p, { now, color, dwell: t === focus ? dwell : null })
    if (t.dying || t.opacity.x < 0.3 || t.state === 'text') continue
    if (p.x > W || p.x + p.w < 0 || p.y > H || p.y + p.h < 0) continue
    next.push({
      id: t.id,
      x: p.x - 6,
      y: p.y + p.h + 10,
      w: p.w,
      state: t.state,
      company: t.company,
      color,
      candidates: t.candidates,
      text: t.lastText,
    })
  }
  labels.value = next
}

// ---- Interaction ----
let down: { x: number; y: number; moved: boolean } | null = null

function onPointerDown(e: PointerEvent) {
  down = { x: e.clientX, y: e.clientY, moved: false }
  ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
}
function onPointerMove(e: PointerEvent) {
  if (!down) return
  const dx = e.clientX - down.x
  const dy = e.clientY - down.y
  if (!down.moved && Math.hypot(dx, dy) < 6) return
  down.moved = true
  const v = view()
  pose.addDrag((-dx / W) * v.fovH, (dy / H) * (v.fovH / v.aspect))
  down.x = e.clientX
  down.y = e.clientY
}
function onPointerUp(e: PointerEvent) {
  const wasTap = down && !down.moved
  down = null
  if (!wasTap || !tracker) return
  const rect = root.value!.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  for (const t of tracker.tracks) {
    if (t.state !== 'locked' || !t.company) continue
    const p = trackPx(t, currentPose, view(), W, H)
    if (x >= p.x - 12 && x <= p.x + p.w + 12 && y >= p.y - 12 && y <= p.y + p.h + 12) {
      store.select(t.company, 'scan', 'half')
      return
    }
  }
  if (tapMode.value) tapScan()
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

function pickCandidate(label: Label, m: MatchResult) {
  const t = tracker?.tracks.find((x) => x.id === label.id)
  t?.lockTo(m.company, performance.now(), true)
  buzz(15)
  store.select(m.company, 'chip', 'half')
}

function dismissCandidates(label: Label) {
  const t = tracker?.tracks.find((x) => x.id === label.id)
  if (t) {
    t.state = 'unknown'
    t.candidates = []
  }
}

/** Tap-to-scan mode: run one detection on the current frame. */
function tapScan() {
  if (!detector) return
  buzz(10)
  detector.submit(currentPose, performance.now())
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
})
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('resize', resize)
  window.removeEventListener('keydown', onKey)
  detector?.dispose()
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
  >
    <video ref="video" class="feed" playsinline muted autoplay />
    <canvas ref="canvas" class="overlay" />

    <div class="labels">
      <div
        v-for="l in labels"
        :key="l.id"
        class="label"
        :style="{ transform: `translate(${l.x}px, ${l.y}px)` }"
        @pointerdown.stop
        @pointerup.stop
      >
        <button
          v-if="l.state === 'locked' && l.company"
          class="chip locked"
          :style="{ '--c': l.color }"
          @click="store.select(l.company, 'scan', 'half')"
        >
          <span class="dot" />{{ l.company.name }}
        </button>
        <template v-else-if="l.state === 'candidates'">
          <span class="hint">Did you mean</span>
          <button v-for="m in l.candidates" :key="m.company.domain" class="chip" @click="pickCandidate(l, m)">
            {{ m.company.name }}
          </button>
          <button class="chip ghost" aria-label="None of these" @click="dismissCandidates(l)">✕</button>
        </template>
        <span v-else-if="l.state === 'reading'" class="chip reading">reading…</span>
        <button v-else-if="l.state === 'unknown'" class="chip ghost" @click="emit('search', l.text)">
          Not recognized · Search
        </button>
      </div>
    </div>

    <div v-if="!started" class="start">
      <div class="start-card">
        <h1>Scout</h1>
        <p>Point your phone at a booth banner. Scout recognizes the company and gets an icebreaker ready.</p>
        <button class="primary" @click="start">Start scanning</button>
        <p class="fine">
          Prototype: a simulated detector reads simulated banners placed around you. Turn to look around, or drag on a
          laptop. Photos you snap go to Google for text recognition and are not stored.
        </p>
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

    <div v-if="started && tuning.showHud" class="hud">
      <span>{{ hud.fps }} fps</span>
      <span>det {{ hud.detFps }}/s · {{ Math.round(hud.inferMs) }} ms</span>
      <span>{{ hud.tracks }} boxes</span>
      <span>{{ caps?.backend }} · {{ tapMode ? 'tap' : 'live' }}</span>
      <span v-if="hud.lowPower">low power</span>
      <span v-if="hud.paused">paused: {{ hud.paused }}</span>
      <span v-if="camera.error.value" class="warn">no camera: {{ camera.error.value }}</span>
      <span>{{ pose.hasSensor ? 'gyro' : 'drag' }}</span>
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
  background: radial-gradient(circle at 50% 35%, #18212e, #0b0d10 70%);
  padding: 24px;
}
.start-card {
  max-width: 340px;
  text-align: center;
  color: #e5e7eb;
}
.start-card h1 {
  font: 800 40px system-ui, sans-serif;
  letter-spacing: -0.03em;
  margin: 0 0 8px;
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
