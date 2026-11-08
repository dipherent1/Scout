<script setup lang="ts">
import { computed } from 'vue'
import { resetTuning, tuning, type Tuning } from '../config'
import { liveStats } from '../camera/stats'
import { useScout } from '../stores/scout'

defineEmits<{ close: [] }>()
const store = useScout()

type NumKey = { [K in keyof Tuning]: Tuning[K] extends number ? K : never }[keyof Tuning]
type BoolKey = { [K in keyof Tuning]: Tuning[K] extends boolean ? K : never }[keyof Tuning]

const groups: { title: string; sliders: { key: NumKey; label: string; min: number; max: number; step: number }[] }[] = [
  {
    title: 'Lock-on and tracking feel',
    sliders: [
      { key: 'springStiffness', label: 'Spring stiffness', min: 40, max: 600, step: 10 },
      { key: 'springDamping', label: 'Spring damping', min: 5, max: 60, step: 1 },
      { key: 'lockHits', label: 'Frames before lock', min: 1, max: 5, step: 1 },
      { key: 'maxMisses', label: 'Missed frames before box drops', min: 1, max: 15, step: 1 },
      { key: 'dwellMs', label: 'Dwell to expand card (ms)', min: 500, max: 5000, step: 100 },
    ],
  },
  {
    title: 'Matching thresholds',
    sliders: [
      { key: 'lockThreshold', label: 'Lock score', min: 0.6, max: 1, step: 0.01 },
      { key: 'chipThreshold', label: 'Chip score', min: 0.3, max: 0.9, step: 0.01 },
      { key: 'fallbackStableFrames', label: 'Frames before "Text unknown"', min: 1, max: 10, step: 1 },
    ],
  },
  {
    title: 'Real OCR (camera)',
    sliders: [
      { key: 'ocrMinConf', label: 'Min word confidence', min: 20, max: 95, step: 1 },
      { key: 'ocrMaxSide', label: 'OCR frame size (px)', min: 480, max: 1600, step: 32 },
    ],
  },
  {
    title: 'Detector (simulated)',
    sliders: [
      { key: 'detectFps', label: 'Detection fps', min: 1, max: 15, step: 1 },
      { key: 'simInferenceMs', label: 'Inference latency (ms)', min: 10, max: 400, step: 5 },
      { key: 'simNoiseDeg', label: 'Box jitter (deg)', min: 0, max: 2, step: 0.05 },
      { key: 'simDropout', label: 'Dropped detections', min: 0, max: 0.6, step: 0.01 },
      { key: 'lowPowerFps', label: 'Low-power fps', min: 1, max: 8, step: 1 },
      { key: 'motionPauseDegPerSec', label: 'Pause above (deg/s)', min: 30, max: 400, step: 10 },
    ],
  },
  {
    title: 'Relevance coloring',
    sliders: [
      { key: 'greenThreshold', label: 'Green at similarity', min: 0.05, max: 0.6, step: 0.01 },
      { key: 'amberThreshold', label: 'Amber at similarity', min: 0, max: 0.4, step: 0.01 },
    ],
  },
]

const toggles: { key: BoolKey; label: string }[] = [
  { key: 'motionCompensation', label: 'Motion compensation (gyro)' },
  { key: 'simulateWithCamera', label: 'Simulated banners instead of real OCR' },
  { key: 'haptics', label: 'Haptics' },
  { key: 'forceTapToScan', label: 'Force tap-to-scan fallback' },
]

const m = computed(() => store.metrics)
const medianLockToCard = computed(() => {
  const a = [...m.value.lockToCardMs].sort((x, y) => x - y)
  return a.length ? a[Math.floor(a.length / 2)] : null
})
const scanSuccess = computed(() => {
  const scans = m.value.scanLocks + m.value.chipPicks
  const total = scans + m.value.manualSearches
  return total ? Math.round((m.value.scanLocks / total) * 100) : null
})

function fmt(v: number) {
  return Number.isInteger(v) ? v : v.toFixed(2)
}

function resetMetrics() {
  Object.assign(store.metrics, {
    scanLocks: 0,
    chipPicks: 0,
    manualSearches: 0,
    serverFallbacks: 0,
    cardsOpened: 0,
    chatsFromIcebreaker: 0,
    followupsDrafted: 0,
    notesSaved: 0,
    lockToCardMs: [],
  })
}
</script>

<template>
  <div class="panel" @pointerdown.stop @pointerup.stop>
    <header>
      <h2>Tuning</h2>
      <button class="link" @click="resetTuning">Reset</button>
      <button class="close" @click="$emit('close')">✕</button>
    </header>
    <div class="scroll">
      <section>
        <h3>Detection (live)</h3>
        <dl>
          <dt>Detector</dt>
          <dd>{{ liveStats.detector || '—' }}</dd>
          <dt>Frame rate / detections</dt>
          <dd>{{ liveStats.fps }} fps / {{ liveStats.detFps }} per s</dd>
          <dt>Inference</dt>
          <dd>{{ Math.round(liveStats.inferMs) }} ms</dd>
          <dt>Boxes</dt>
          <dd>{{ liveStats.tracks }}</dd>
          <dt>Status</dt>
          <dd>{{ liveStats.paused ? 'paused: ' + liveStats.paused : liveStats.lowPower ? 'low power' : 'scanning' }}</dd>
          <dt>Orientation / camera</dt>
          <dd>{{ liveStats.sensor }}{{ liveStats.cameraError ? ' · no camera: ' + liveStats.cameraError : '' }}</dd>
        </dl>
      </section>
      <section v-for="g in groups" :key="g.title">
        <h3>{{ g.title }}</h3>
        <label v-for="s in g.sliders" :key="s.key" class="slider">
          <span>{{ s.label }}</span>
          <input v-model.number="tuning[s.key]" type="range" :min="s.min" :max="s.max" :step="s.step" />
          <output>{{ fmt(tuning[s.key]) }}</output>
        </label>
      </section>
      <section>
        <h3>Options</h3>
        <label v-for="t in toggles" :key="t.key" class="toggle">
          <input v-model="tuning[t.key]" type="checkbox" />
          <span>{{ t.label }}</span>
        </label>
      </section>
      <section>
        <h3>Profile</h3>
        <p class="bio">{{ store.bio || 'No bio yet.' }}</p>
        <button class="link" @click="store.onboardingOpen = true">Edit bio</button>
      </section>
      <section>
        <h3>Metrics (this device)</h3>
        <dl>
          <dt>Scan success (lock vs manual)</dt>
          <dd>{{ scanSuccess === null ? '—' : scanSuccess + '%' }}</dd>
          <dt>Locks / chip picks / searches</dt>
          <dd>{{ m.scanLocks }} / {{ m.chipPicks }} / {{ m.manualSearches }}</dd>
          <dt>Server fallbacks</dt>
          <dd>{{ m.serverFallbacks }}</dd>
          <dt>Median lock to card</dt>
          <dd>{{ medianLockToCard === null ? '—' : medianLockToCard + ' ms' }}</dd>
          <dt>Chats from icebreaker</dt>
          <dd>{{ m.chatsFromIcebreaker }} of {{ m.cardsOpened }} cards</dd>
          <dt>Notes / follow-ups</dt>
          <dd>{{ m.notesSaved }} / {{ m.followupsDrafted }}</dd>
        </dl>
        <button class="link" @click="resetMetrics">Reset metrics</button>
      </section>
      <section>
        <h3>Status</h3>
        <dl>
          <dt>Bundle</dt>
          <dd>{{ store.companies.length }} companies ({{ store.bundleSource }})</dd>
          <dt>API</dt>
          <dd>{{ store.apiStatus }}{{ store.apiStatus === 'online' ? (store.geminiEnabled ? ' · Gemini on' : ' · Gemini off') : '' }}</dd>
        </dl>
      </section>
    </div>
  </div>
</template>

<style scoped>
.panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(380px, 100%);
  z-index: 45;
  background: rgba(12, 15, 20, 0.97);
  border-left: 1px solid rgba(255, 255, 255, 0.08);
  color: #e5e7eb;
  display: flex;
  flex-direction: column;
  padding-top: env(safe-area-inset-top);
}
header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
h2 {
  flex: 1;
  margin: 0;
  font: 700 18px system-ui;
}
.scroll {
  overflow-y: auto;
  padding: 8px 16px 40px;
}
h3 {
  font: 700 11px system-ui;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #64748b;
  margin: 18px 0 8px;
}
.slider {
  display: grid;
  grid-template-columns: 1fr 44px;
  grid-template-areas: 'label out' 'range range';
  gap: 2px 8px;
  margin-bottom: 10px;
  font-size: 13px;
}
.slider span {
  grid-area: label;
  color: #cbd5e1;
}
.slider input {
  grid-area: range;
  width: 100%;
  accent-color: #5eead4;
}
.slider output {
  grid-area: out;
  text-align: right;
  font: 12px ui-monospace, monospace;
  color: #5eead4;
}
.toggle {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 14px;
  margin-bottom: 8px;
}
.toggle input {
  accent-color: #5eead4;
  width: 18px;
  height: 18px;
}
dl {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 6px 10px;
  font-size: 13px;
  margin: 0;
}
dt {
  color: #94a3b8;
}
dd {
  margin: 0;
  text-align: right;
}
.bio {
  font-size: 13px;
  color: #cbd5e1;
  margin: 0 0 6px;
}
.link {
  background: none;
  border: 0;
  color: #5eead4;
  font: 600 13px system-ui;
  cursor: pointer;
  padding: 4px 0;
}
.close {
  background: rgba(255, 255, 255, 0.08);
  border: 0;
  color: #cbd5e1;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  cursor: pointer;
}
</style>
