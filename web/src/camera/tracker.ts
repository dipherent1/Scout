import type { AngularBox, Company, DetectionResult, MatchResult, Pose } from '../types'
import type { Matcher } from '../match/matcher'
import { toAngular, wrapDeg, type View } from './projection'

/**
 * Turns 5-10 fps detections into stable, 60 fps boxes.
 *
 * - Detections are converted to world (angular) coordinates using the pose of
 *   the frame they came from, so a 100 ms-old detection still lands on the
 *   banner even if the phone has moved since (motion compensation).
 * - Each track's box chases its latest detection with a spring, which hides
 *   detector jitter without the lag of a heavy low-pass filter.
 * - Match scores are voted over the last few frames, so one misread neither
 *   locks nor unlocks a box.
 */

export type TrackState = 'text' | 'candidates' | 'locked' | 'reading' | 'unknown'

export interface TrackerParams {
  lockThreshold: number
  chipThreshold: number
  lockHits: number
  fallbackStableFrames: number
  maxMisses: number
  motionCompensation: boolean
  springStiffness: number
  springDamping: number
}

class Spring {
  v = 0
  constructor(public x: number) {}
  step(target: number, k: number, c: number, dt: number) {
    const a = k * (target - this.x) - c * this.v
    this.v += a * dt
    this.x += this.v * dt
  }
}

const VOTE_WINDOW = 5

export class Track {
  readonly id: number
  yaw: Spring
  pitch: Spring
  w: Spring
  h: Spring
  target: AngularBox
  opacity = new Spring(0)
  /** Reticle scale; jumps above 1 on lock and springs back for the lock-on bounce. */
  lockScale = new Spring(1)
  texts: string[] = []
  frames: MatchResult[][] = []
  hits = 1
  misses = 0
  state: TrackState = 'text'
  company: Company | null = null
  candidates: MatchResult[] = []
  lockedAt = 0
  firstSeen: number
  lastSeenAt: number
  /** Consecutive detections whose text matched nothing; drives the server fallback. */
  stableNoMatch = 0
  fallbackRequested = false
  userConfirmed = false
  dying = false

  constructor(id: number, box: AngularBox, now: number) {
    this.id = id
    this.target = box
    this.yaw = new Spring(box.yaw)
    this.pitch = new Spring(box.pitch)
    this.w = new Spring(box.w)
    this.h = new Spring(box.h)
    this.firstSeen = now
    this.lastSeenAt = now
  }

  get box(): AngularBox {
    return { yaw: this.yaw.x, pitch: this.pitch.x, w: this.w.x, h: this.h.x }
  }

  get lastText(): string {
    return this.texts[this.texts.length - 1] ?? ''
  }

  /** Average score per company over the vote window, best first. */
  tally(): MatchResult[] {
    const sums = new Map<Company, number>()
    for (const frame of this.frames) for (const m of frame) sums.set(m.company, (sums.get(m.company) ?? 0) + m.score)
    const n = Math.max(1, this.frames.length)
    return [...sums.entries()].map(([company, s]) => ({ company, score: s / n })).sort((a, b) => b.score - a.score)
  }

  lockTo(company: Company, now: number, byUser = false) {
    const changed = this.company !== company
    this.company = company
    this.state = 'locked'
    this.candidates = []
    this.userConfirmed = this.userConfirmed || byUser
    if (changed) {
      this.lockedAt = now
      this.lockScale.x = 1.55
      this.lockScale.v = 0
    }
  }
}

export interface TrackerEvents {
  locked: Track[]
  needsFallback: Track[]
}

export class Tracker {
  tracks: Track[] = []
  private nextId = 1
  /** performance.now() of the last detection that produced a match; drives low-power mode. */
  lastHitAt = 0

  constructor(private matcher: Matcher, public params: TrackerParams) {}

  setMatcher(m: Matcher) {
    this.matcher = m
  }

  ingest(result: DetectionResult, currentPose: Pose, view: View, now: number): TrackerEvents {
    const p = this.params
    const events: TrackerEvents = { locked: [], needsFallback: [] }
    const pose = p.motionCompensation ? result.pose : currentPose
    const dets = result.detections.map((d) => ({ d, box: toAngular(d, pose, view) }))

    // Greedy association by normalized center distance.
    const live = this.tracks.filter((t) => !t.dying)
    const pairs: { t: Track; i: number; cost: number }[] = []
    for (const t of live) {
      dets.forEach(({ box }, i) => {
        const scale = Math.max(t.target.w, box.w, 1)
        const cost = Math.hypot(wrapDeg(box.yaw - t.target.yaw) / scale, (box.pitch - t.target.pitch) / Math.max(t.target.h, box.h, 0.5))
        const sizeRatio = box.w / t.target.w
        if (cost < 0.9 && sizeRatio > 0.4 && sizeRatio < 2.5) pairs.push({ t, i, cost })
      })
    }
    pairs.sort((a, b) => a.cost - b.cost)
    const usedT = new Set<Track>()
    const usedD = new Set<number>()
    for (const { t, i } of pairs) {
      if (usedT.has(t) || usedD.has(i)) continue
      usedT.add(t)
      usedD.add(i)
      this.observe(t, dets[i].box, dets[i].d.text, now, events)
    }
    for (const t of live) {
      if (usedT.has(t)) continue
      t.misses++
      if (t.misses > p.maxMisses) t.dying = true
    }
    dets.forEach(({ box, d }, i) => {
      if (usedD.has(i)) return
      const t = new Track(this.nextId++, box, now)
      t.hits = 0
      this.tracks.push(t)
      this.observe(t, box, d.text, now, events)
    })
    return events
  }

  private observe(t: Track, box: AngularBox, text: string, now: number, events: TrackerEvents) {
    const p = this.params
    t.target = box
    t.lastSeenAt = now
    t.hits++
    t.misses = 0
    t.texts.push(text)
    if (t.texts.length > VOTE_WINDOW) t.texts.shift()
    const m = this.matcher.match(text, 0.4)
    t.frames.push(m.candidates)
    if (t.frames.length > VOTE_WINDOW) t.frames.shift()

    const tally = t.tally()
    const best = tally[0]
    if (best && best.score >= p.chipThreshold) this.lastHitAt = now

    if (t.state === 'locked') {
      // Stay locked unless several frames now clearly read a different company.
      if (!t.userConfirmed && best && best.company !== t.company && best.score >= p.lockThreshold && t.frames.length >= VOTE_WINDOW) {
        const current = tally.find((r) => r.company === t.company)?.score ?? 0
        if (current < p.chipThreshold) {
          t.lockTo(best.company, now)
          events.locked.push(t)
        }
      }
      return
    }
    if (t.state === 'reading') return

    if (best && best.score >= p.lockThreshold && t.hits >= p.lockHits) {
      t.lockTo(best.company, now)
      events.locked.push(t)
      return
    }
    if (best && best.score >= p.chipThreshold) {
      t.state = 'candidates'
      t.candidates = tally.filter((r) => r.score >= p.chipThreshold * 0.85).slice(0, 3)
      t.stableNoMatch = 0
      return
    }
    if (t.state === 'unknown') return
    t.state = 'text'
    t.candidates = []
    if (text.replace(/[^a-z0-9]/gi, '').length >= 3) t.stableNoMatch++
    else t.stableNoMatch = 0
    if (t.stableNoMatch >= p.fallbackStableFrames && !t.fallbackRequested) {
      t.fallbackRequested = true
      events.needsFallback.push(t)
    }
  }

  /** Advance springs; call every animation frame. */
  animate(dtMs: number) {
    const { springStiffness: k, springDamping: c } = this.params
    let remaining = Math.min(dtMs, 64) / 1000
    while (remaining > 0) {
      const dt = Math.min(remaining, 1 / 120)
      remaining -= dt
      for (const t of this.tracks) {
        t.yaw.step(t.target.yaw, k, c, dt)
        t.pitch.step(t.target.pitch, k, c, dt)
        t.w.step(t.target.w, k, c, dt)
        t.h.step(t.target.h, k, c, dt)
        // Missed frames fade the box a little; a dead track fades out fully.
        const targetOpacity = t.dying ? 0 : t.misses > 1 ? 0.55 : 1
        t.opacity.step(targetOpacity, 90, 18, dt)
        t.lockScale.step(1, 320, 13, dt)
      }
    }
    this.tracks = this.tracks.filter((t) => !(t.dying && t.opacity.x < 0.03))
  }

  clear() {
    this.tracks = []
  }
}
