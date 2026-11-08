import { describe, expect, it } from 'vitest'
import { Matcher } from '../match/matcher'
import { SAMPLE_COMPANIES } from '../match/store'
import type { Detection, Pose } from '../types'
import { toScreen } from './projection'
import { Tracker } from './tracker'

const view = { fovH: 52, aspect: 0.5 }
const params = {
  lockThreshold: 0.85,
  chipThreshold: 0.6,
  lockHits: 2,
  fallbackStableFrames: 3,
  maxMisses: 3,
  motionCompensation: true,
  springStiffness: 220,
  springDamping: 26,
}

function det(text: string, yaw: number, pitch: number, pose: Pose): Detection {
  const s = toScreen({ yaw, pitch, w: 14, h: 4 }, pose, view)
  return { ...s, text, conf: 0.9 }
}

function frame(id: number, pose: Pose, dets: Detection[]) {
  return { frameId: id, frameTime: id * 100, pose, inferenceMs: 50, detections: dets }
}

describe('tracker', () => {
  it('locks after the configured number of hits, not on the first frame', () => {
    const t = new Tracker(new Matcher(SAMPLE_COMPANIES), params)
    const pose = { yaw: 0, pitch: 0 }
    const e1 = t.ingest(frame(1, pose, [det('stripe', 0, 0, pose)]), pose, view, 100)
    expect(e1.locked).toHaveLength(0)
    expect(t.tracks).toHaveLength(1)
    const e2 = t.ingest(frame(2, pose, [det('stripe', 0.3, 0.1, pose)]), pose, view, 200)
    expect(e2.locked).toHaveLength(1)
    expect(t.tracks[0].company?.name).toBe('Stripe')
    expect(t.tracks).toHaveLength(1)
  })

  it('does not unlock on a single misread', () => {
    const t = new Tracker(new Matcher(SAMPLE_COMPANIES), params)
    const pose = { yaw: 0, pitch: 0 }
    for (let i = 1; i <= 3; i++) t.ingest(frame(i, pose, [det('DATADOG', 0, 0, pose)]), pose, view, i * 100)
    t.ingest(frame(4, pose, [det('D4TAD', 0, 0, pose)]), pose, view, 400)
    expect(t.tracks[0].state).toBe('locked')
    expect(t.tracks[0].company?.name).toBe('Datadog')
  })

  it('shows chips for garbled text and asks the server for stable unknown text', () => {
    const t = new Tracker(new Matcher(SAMPLE_COMPANIES), params)
    const pose = { yaw: 0, pitch: 0 }
    let fallback = 0
    for (let i = 1; i <= 4; i++) {
      const ev = t.ingest(frame(i, pose, [det('CIOUDFIARE', -10, 0, pose), det('NOVA ROBOTICS', 12, 0, pose)]), pose, view, i * 100)
      fallback += ev.needsFallback.length
    }
    const cf = t.tracks.find((x) => x.lastText === 'CIOUDFIARE')!
    const nova = t.tracks.find((x) => x.lastText === 'NOVA ROBOTICS')!
    expect(cf.state).toBe('candidates')
    expect(cf.candidates[0].company.name).toBe('Cloudflare')
    expect(nova.state).toBe('text')
    expect(fallback).toBe(1)
  })

  it('motion compensation keeps a stale detection on the banner', () => {
    const t = new Tracker(new Matcher(SAMPLE_COMPANIES), params)
    const framePose = { yaw: 0, pitch: 0 }
    const nowPose = { yaw: 8, pitch: 0 } // phone turned 8 degrees while the detector ran
    t.ingest(frame(1, framePose, [det('stripe', 5, 0, framePose)]), nowPose, view, 100)
    expect(t.tracks[0].target.yaw).toBeCloseTo(5, 5)
    const naive = new Tracker(new Matcher(SAMPLE_COMPANIES), { ...params, motionCompensation: false })
    naive.ingest(frame(1, framePose, [det('stripe', 5, 0, framePose)]), nowPose, view, 100)
    expect(naive.tracks[0].target.yaw).toBeCloseTo(13, 5)
  })

  it('drops a track after max misses and fades it out', () => {
    const t = new Tracker(new Matcher(SAMPLE_COMPANIES), params)
    const pose = { yaw: 0, pitch: 0 }
    t.ingest(frame(1, pose, [det('stripe', 0, 0, pose)]), pose, view, 100)
    for (let i = 2; i <= 6; i++) t.ingest(frame(i, pose, []), pose, view, i * 100)
    expect(t.tracks[0].dying).toBe(true)
    for (let i = 0; i < 60; i++) t.animate(16)
    expect(t.tracks).toHaveLength(0)
  })

  it('spring converges to the target', () => {
    const t = new Tracker(new Matcher(SAMPLE_COMPANIES), params)
    const pose = { yaw: 0, pitch: 0 }
    t.ingest(frame(1, pose, [det('stripe', 0, 0, pose)]), pose, view, 100)
    t.ingest(frame(2, pose, [det('stripe', 3, 1, pose)]), pose, view, 200)
    for (let i = 0; i < 40; i++) t.animate(16)
    expect(t.tracks[0].box.yaw).toBeCloseTo(3, 1)
    expect(t.tracks[0].box.pitch).toBeCloseTo(1, 1)
  })
})
