/// <reference lib="webworker" />
/**
 * Simulated text detector. Runs in a Web Worker exactly where the ONNX
 * detector will run, speaks the same protocol, and behaves like a real one:
 * it has inference latency, positional jitter, dropped frames, OCR misreads,
 * and clipped text at the edge of the frame. It never invents text that is
 * not in the scene, so the overlay follows the "never fake detections" rule
 * relative to the simulated world.
 */
import { toScreen } from '../camera/projection'
import type { Detection } from '../types'
import type { FromWorker, SimSettings, ToWorker } from './protocol'
import { BOOTHS, type Booth } from './scene'

declare const self: DedicatedWorkerGlobalScope

let settings: SimSettings = { inferenceMs: 70, noiseDeg: 0.35, dropout: 0.1, fovH: 52, aspect: 0.5 }

function post(msg: FromWorker) {
  self.postMessage(msg)
}

function gauss(): number {
  // Box-Muller
  const u = 1 - Math.random()
  const v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

const CONFUSE: Record<string, string> = { o: '0', O: '0', l: '1', I: '1', s: '5', S: '5', B: '8', e: 'c', a: 'o', n: 'm', D: 'O' }

function corrupt(text: string): string {
  const chars = [...text]
  const i = Math.floor(Math.random() * chars.length)
  const r = Math.random()
  if (r < 0.5 && CONFUSE[chars[i]]) chars[i] = CONFUSE[chars[i]]
  else if (r < 0.8) chars.splice(i, 1)
  else chars.splice(i, 0, chars[i])
  return chars.join('')
}

function readText(b: Booth): string {
  switch (b.kind) {
    case 'hard':
      return b.misreads![Math.floor(Math.random() * b.misreads!.length)]
    case 'clean':
      return Math.random() < 0.85 ? b.text : corrupt(b.text)
    default:
      return Math.random() < 0.9 ? b.text : corrupt(b.text)
  }
}

function detect(pose: { yaw: number; pitch: number }): Detection[] {
  const view = { fovH: settings.fovH, aspect: settings.aspect }
  const out: Detection[] = []
  for (const b of BOOTHS) {
    if (Math.random() < settings.dropout) continue
    const noisy = {
      yaw: b.yaw + gauss() * settings.noiseDeg,
      pitch: b.pitch + gauss() * settings.noiseDeg,
      w: b.w * (1 + gauss() * 0.03),
      h: b.h * (1 + gauss() * 0.03),
    }
    const s = toScreen(noisy, pose, view)
    // Clip to the frame.
    const x0 = Math.max(0, s.x)
    const y0 = Math.max(0, s.y)
    const x1 = Math.min(1, s.x + s.w)
    const y1 = Math.min(1, s.y + s.h)
    if (x1 <= x0 || y1 <= y0) continue
    const visible = (x1 - x0) / s.w
    if (visible < 0.35 || (y1 - y0) / s.h < 0.5) continue
    let text = readText(b)
    if (visible < 0.97) {
      // Only part of the banner is in frame, so OCR only reads part of the text.
      const keep = Math.max(1, Math.round(text.length * visible))
      text = s.x < 0 ? text.slice(text.length - keep) : text.slice(0, keep)
    }
    out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, text, conf: 0.6 + Math.random() * 0.4 })
  }
  return out
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data
  if (msg.type === 'init') {
    settings = { ...settings, ...msg.settings }
    post({ type: 'ready', backend: 'simulated' })
  } else if (msg.type === 'settings') {
    settings = { ...settings, ...msg.settings }
  } else if (msg.type === 'frame') {
    msg.bitmap?.close()
    const start = performance.now()
    const detections = detect(msg.pose)
    const latency = Math.max(5, settings.inferenceMs * (0.75 + Math.random() * 0.5))
    setTimeout(() => {
      post({
        type: 'result',
        frameId: msg.frameId,
        frameTime: msg.frameTime,
        pose: msg.pose,
        inferenceMs: performance.now() - start,
        detections,
      })
    }, latency)
  }
}
