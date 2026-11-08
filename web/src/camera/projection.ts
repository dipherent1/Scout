import type { AngularBox, Pose } from '../types'

/**
 * Simple linear projection between angular "world" boxes (degrees) and
 * normalized screen coordinates (0..1, origin top-left). Good enough within a
 * phone camera's field of view.
 */
export interface View {
  fovH: number
  /** width / height of the viewport */
  aspect: number
}

export function fovV(view: View): number {
  return view.fovH / view.aspect
}

export function wrapDeg(d: number): number {
  return ((((d + 180) % 360) + 360) % 360) - 180
}

/** Center-based angular box -> normalized screen box (x, y = top-left). */
export function toScreen(b: AngularBox, pose: Pose, view: View) {
  const fv = fovV(view)
  const cx = 0.5 + wrapDeg(b.yaw - pose.yaw) / view.fovH
  const cy = 0.5 - (b.pitch - pose.pitch) / fv
  const w = b.w / view.fovH
  const h = b.h / fv
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}

/** Normalized screen box (x, y = top-left) -> center-based angular box. */
export function toAngular(s: { x: number; y: number; w: number; h: number }, pose: Pose, view: View): AngularBox {
  const fv = fovV(view)
  const cx = s.x + s.w / 2
  const cy = s.y + s.h / 2
  return {
    yaw: pose.yaw + (cx - 0.5) * view.fovH,
    pitch: pose.pitch - (cy - 0.5) * fv,
    w: s.w * view.fovH,
    h: s.h * fv,
  }
}
