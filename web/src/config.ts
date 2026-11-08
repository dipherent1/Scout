import { reactive, watch } from 'vue'

/**
 * Every number the scan loop depends on. All of them are guesses to tune on a
 * real phone (see scout.md, "Scan pipeline"). The tuning panel edits this
 * object live and it persists to localStorage.
 */
export interface Tuning {
  // Detector
  detectFps: number
  lowPowerFps: number
  lowPowerAfterMs: number
  motionPauseDegPerSec: number
  simInferenceMs: number
  simNoiseDeg: number
  simDropout: number
  // Matching
  lockThreshold: number
  chipThreshold: number
  lockHits: number
  fallbackStableFrames: number
  fallbackMinIntervalMs: number
  // Tracker / animation
  springStiffness: number
  springDamping: number
  maxMisses: number
  motionCompensation: boolean
  // UI
  dwellMs: number
  showSimScene: boolean
  showHud: boolean
  haptics: boolean
  forceTapToScan: boolean
  greenThreshold: number
  amberThreshold: number
}

export const DEFAULT_TUNING: Tuning = {
  detectFps: 8,
  lowPowerFps: 3,
  lowPowerAfterMs: 10_000,
  motionPauseDegPerSec: 120,
  simInferenceMs: 70,
  simNoiseDeg: 0.35,
  simDropout: 0.1,
  lockThreshold: 0.85,
  chipThreshold: 0.6,
  lockHits: 2,
  fallbackStableFrames: 3,
  fallbackMinIntervalMs: 2000,
  springStiffness: 220,
  springDamping: 26,
  maxMisses: 5,
  motionCompensation: true,
  dwellMs: 2000,
  showSimScene: true,
  showHud: true,
  haptics: true,
  forceTapToScan: false,
  greenThreshold: 0.2,
  amberThreshold: 0.08,
}

const KEY = 'scout.tuning.v1'

function load(): Tuning {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { ...DEFAULT_TUNING, ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_TUNING }
}

export const tuning = reactive<Tuning>(typeof localStorage === 'undefined' ? { ...DEFAULT_TUNING } : load())

if (typeof localStorage !== 'undefined') {
  watch(tuning, (t) => localStorage.setItem(KEY, JSON.stringify(t)), { deep: true })
}

export function resetTuning() {
  Object.assign(tuning, DEFAULT_TUNING)
}

/** Horizontal field of view of a typical phone main camera in portrait, in degrees. */
export const FOV_H_DEG = 52
