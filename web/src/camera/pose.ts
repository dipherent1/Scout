import type { Pose } from '../types'
import { wrapDeg } from './projection'

const DEG = Math.PI / 180

/**
 * Camera heading from the gyroscope when available, plus a drag offset so the
 * prototype also works on a laptop (drag the scene or use the arrow keys).
 * Without a gyroscope it adds a small simulated hand shake so the tracker's
 * smoothing can still be tuned.
 */
export class PoseSource {
  private sensor: Pose | null = null
  private sensorZero: Pose | null = null
  private drag: Pose = { yaw: 0, pitch: 0 }
  private last: Pose = { yaw: 0, pitch: 0 }
  private lastT = 0
  /** Angular speed in degrees per second (for the motion-blur pause). */
  speed = 0
  hasSensor = false
  private onOrientation = (e: DeviceOrientationEvent) => this.handleOrientation(e)

  async start(requestPermission: boolean) {
    const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }
    if (requestPermission && typeof DOE?.requestPermission === 'function') {
      try {
        if ((await DOE.requestPermission()) !== 'granted') return
      } catch {
        return
      }
    }
    window.addEventListener('deviceorientation', this.onOrientation)
  }

  stop() {
    window.removeEventListener('deviceorientation', this.onOrientation)
  }

  /** Recenter so the current direction is yaw 0. */
  recenter() {
    this.sensorZero = this.sensor ? { ...this.sensor } : null
    this.drag = { yaw: 0, pitch: 0 }
  }

  addDrag(dYaw: number, dPitch: number) {
    this.drag.yaw += dYaw
    this.drag.pitch = Math.max(-40, Math.min(40, this.drag.pitch + dPitch))
  }

  private handleOrientation(e: DeviceOrientationEvent) {
    if (e.alpha == null || e.beta == null || e.gamma == null) return
    const a = e.alpha * DEG
    const b = e.beta * DEG
    const g = e.gamma * DEG
    // Back-camera direction = -Z axis of the device, rotated by Z-X'-Y'' (alpha, beta, gamma).
    const fx = -(Math.cos(a) * Math.sin(g) + Math.sin(a) * Math.sin(b) * Math.cos(g))
    const fy = -(Math.sin(a) * Math.sin(g) - Math.cos(a) * Math.sin(b) * Math.cos(g))
    const fz = -(Math.cos(b) * Math.cos(g))
    // World frame is x = east, y = north, z = up; heading is clockwise from north.
    const yaw = Math.atan2(fx, fy) / DEG
    const pitch = Math.asin(Math.max(-1, Math.min(1, fz))) / DEG
    this.sensor = { yaw, pitch }
    if (!this.sensorZero) this.sensorZero = { yaw, pitch: 0 }
    this.hasSensor = true
  }

  /** Current pose; call once per animation frame. */
  read(now: number): Pose {
    let yaw = this.drag.yaw
    let pitch = this.drag.pitch
    if (this.sensor && this.sensorZero) {
      yaw += wrapDeg(this.sensor.yaw - this.sensorZero.yaw)
      pitch += this.sensor.pitch - this.sensorZero.pitch
    } else {
      // Simulated hand shake: a few incommensurate sines, about half a degree.
      const t = now / 1000
      yaw += 0.35 * Math.sin(t * 1.7) + 0.15 * Math.sin(t * 4.3 + 1)
      pitch += 0.25 * Math.sin(t * 2.1 + 2) + 0.1 * Math.sin(t * 5.9)
    }
    const pose = { yaw: wrapDeg(yaw), pitch }
    if (this.lastT) {
      const dt = Math.max(1, now - this.lastT) / 1000
      const inst = Math.hypot(wrapDeg(pose.yaw - this.last.yaw), pose.pitch - this.last.pitch) / dt
      this.speed = this.speed * 0.8 + inst * 0.2
    }
    this.last = pose
    this.lastT = now
    return pose
  }
}
