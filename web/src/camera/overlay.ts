import type { Relevance } from '../types'
import type { Pose } from '../types'
import { toScreen, type View } from './projection'
import type { Track } from './tracker'
import { BOOTHS } from '../detect/scene'

export const RELEVANCE_COLOR: Record<Relevance, string> = {
  high: '#34d399',
  medium: '#fbbf24',
  neutral: '#f3f4f6',
}

export interface Px {
  x: number
  y: number
  w: number
  h: number
}

export function trackPx(t: Track, pose: Pose, view: View, W: number, H: number): Px {
  const s = toScreen(t.box, pose, view)
  return { x: s.x * W, y: s.y * H, w: s.w * W, h: s.h * H }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2))
}

/** Venue backdrop used when there is no camera (laptop, permission denied). */
export function drawVenue(ctx: CanvasRenderingContext2D, pose: Pose, view: View, W: number, H: number) {
  const horizon = H * (0.5 + pose.pitch / (view.fovH / view.aspect))
  const g = ctx.createLinearGradient(0, 0, 0, H)
  g.addColorStop(0, '#1b2230')
  g.addColorStop(Math.max(0, Math.min(1, horizon / H)), '#2a3242')
  g.addColorStop(1, '#151a22')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)
  // Pillars every 15 degrees so panning reads as motion.
  ctx.fillStyle = 'rgba(255,255,255,0.035)'
  const start = Math.floor((pose.yaw - view.fovH) / 15) * 15
  for (let yaw = start; yaw < pose.yaw + view.fovH; yaw += 15) {
    const s = toScreen({ yaw, pitch: 0, w: 1.2, h: 200 }, pose, view)
    ctx.fillRect(s.x * W, 0, s.w * W, H)
  }
  ctx.fillStyle = 'rgba(0,0,0,0.25)'
  ctx.fillRect(0, horizon + H * 0.12, W, H)
}

/** The simulated banners. Drawn under the overlay so you can see what the phone "sees". */
export function drawBooths(ctx: CanvasRenderingContext2D, pose: Pose, view: View, W: number, H: number, overCamera: boolean) {
  for (const b of BOOTHS) {
    const s = toScreen(b, pose, view)
    const x = s.x * W
    const y = s.y * H
    const w = s.w * W
    const h = s.h * H
    if (x > W || x + w < 0 || y > H || y + h < 0) continue
    ctx.save()
    ctx.globalAlpha = overCamera ? 0.82 : 1
    ctx.shadowColor = 'rgba(0,0,0,0.45)'
    ctx.shadowBlur = 18
    ctx.shadowOffsetY = 6
    ctx.fillStyle = b.color
    roundRect(ctx, x, y, w, h, h * 0.12)
    ctx.fill()
    ctx.shadowColor = 'transparent'
    // Stand legs
    ctx.fillStyle = 'rgba(120,130,145,0.6)'
    ctx.fillRect(x + w * 0.12, y + h, 3, h * 1.6)
    ctx.fillRect(x + w * 0.88 - 3, y + h, 3, h * 1.6)
    // Text, sized to fit
    ctx.fillStyle = b.textColor
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    let size = h * 0.56
    ctx.font = b.font.replace('1em', `${size}px`)
    const tw = ctx.measureText(b.text).width
    if (tw > w * 0.86) {
      size *= (w * 0.86) / tw
      ctx.font = b.font.replace('1em', `${size}px`)
    }
    ctx.fillText(b.text, x + w / 2, y + h / 2 + size * 0.04)
    ctx.restore()
  }
}

function brackets(ctx: CanvasRenderingContext2D, p: Px, len: number) {
  const { x, y, w, h } = p
  ctx.beginPath()
  ctx.moveTo(x, y + len)
  ctx.lineTo(x, y)
  ctx.lineTo(x + len, y)
  ctx.moveTo(x + w - len, y)
  ctx.lineTo(x + w, y)
  ctx.lineTo(x + w, y + len)
  ctx.moveTo(x + w, y + h - len)
  ctx.lineTo(x + w, y + h)
  ctx.lineTo(x + w - len, y + h)
  ctx.moveTo(x + len, y + h)
  ctx.lineTo(x, y + h)
  ctx.lineTo(x, y + h - len)
  ctx.stroke()
}

export interface DrawOpts {
  now: number
  color: string
  /** 0..1 progress of the dwell cue, or null. */
  dwell: number | null
}

export function drawTrack(ctx: CanvasRenderingContext2D, t: Track, p: Px, o: DrawOpts) {
  const alpha = Math.max(0, Math.min(1, t.opacity.x))
  if (alpha < 0.02) return
  ctx.save()
  ctx.globalAlpha = alpha
  const pad = 6
  const box = { x: p.x - pad, y: p.y - pad, w: p.w + pad * 2, h: p.h + pad * 2 }

  if (t.state === 'locked') {
    const s = t.lockScale.x
    const cx = box.x + box.w / 2
    const cy = box.y + box.h / 2
    const r = { x: cx - (box.w * s) / 2, y: cy - (box.h * s) / 2, w: box.w * s, h: box.h * s }
    ctx.fillStyle = o.color + '1f'
    roundRect(ctx, r.x, r.y, r.w, r.h, 10)
    ctx.fill()
    ctx.strokeStyle = o.color
    ctx.lineWidth = 3
    ctx.lineCap = 'round'
    ctx.shadowColor = o.color
    ctx.shadowBlur = 12
    brackets(ctx, r, Math.min(22, r.w / 4, r.h / 2))
    if (o.dwell !== null && o.dwell > 0) {
      ctx.shadowBlur = 0
      ctx.lineWidth = 3
      ctx.globalAlpha = alpha * 0.9
      ctx.beginPath()
      ctx.arc(r.x + r.w, r.y, 9, -Math.PI / 2, -Math.PI / 2 + o.dwell * Math.PI * 2)
      ctx.stroke()
    }
  } else if (t.state === 'reading') {
    // Shimmer sweeping across the box while the server reads it.
    const phase = ((o.now / 900) % 1) * (box.w + 120) - 60
    const g = ctx.createLinearGradient(box.x + phase - 60, 0, box.x + phase + 60, 0)
    g.addColorStop(0, 'rgba(255,255,255,0)')
    g.addColorStop(0.5, 'rgba(255,255,255,0.28)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    roundRect(ctx, box.x, box.y, box.w, box.h, 8)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'
    ctx.lineWidth = 1.5
    ctx.stroke()
  } else {
    // Faint boxes over detected text; brightness follows how recently the detector saw it.
    const fresh = Math.exp(-(o.now - t.lastSeenAt) / 160)
    const base = t.state === 'candidates' ? 0.55 : t.state === 'unknown' ? 0.3 : 0.22
    ctx.globalAlpha = alpha * (base + 0.35 * fresh)
    ctx.strokeStyle = t.state === 'candidates' ? '#fbbf24' : '#ffffff'
    ctx.lineWidth = t.state === 'candidates' ? 2 : 1.25
    ctx.setLineDash(t.state === 'text' ? [] : [6, 5])
    roundRect(ctx, box.x, box.y, box.w, box.h, 6)
    ctx.stroke()
  }
  ctx.restore()
}
