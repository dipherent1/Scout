import type { AngularBox } from '../types'

/**
 * The simulated venue: banners placed around the user, in degrees relative to
 * the starting heading. The simulated detector "sees" these, and the sim scene
 * layer draws them so you can tell what the phone is pointed at.
 *
 * kind:
 *   clean    - OCR reads the name correctly most of the time  -> lock
 *   hard     - stylized font, OCR always garbles it           -> "Did you mean" chips
 *   unknown  - a real company that is not in the bundle       -> server fallback
 *   noise    - readable text that is not a company            -> faint box only
 *   collide  - a common word that contains a company name     -> chip, never a lock
 */
export type BoothKind = 'clean' | 'hard' | 'unknown' | 'noise' | 'collide'

export interface Booth extends AngularBox {
  id: string
  text: string
  kind: BoothKind
  /** Strings the "OCR" returns for hard booths. */
  misreads?: string[]
  color: string
  textColor: string
  font: string
}

export const BOOTHS: Booth[] = [
  { id: 'b-stripe', text: 'stripe', kind: 'clean', yaw: -8, pitch: 4, w: 16, h: 5, color: '#635bff', textColor: '#ffffff', font: '700 1em system-ui' },
  { id: 'b-datadog', text: 'DATADOG', kind: 'clean', yaw: 13, pitch: 1, w: 15, h: 4.5, color: '#632ca6', textColor: '#ffffff', font: '800 1em system-ui' },
  { id: 'b-coffee', text: 'FREE COFFEE', kind: 'noise', yaw: 4, pitch: -11, w: 9, h: 3, color: '#f5efe6', textColor: '#3b2a1a', font: '700 1em Georgia, serif' },
  { id: 'b-cloudflare', text: 'CLOUDFLARE', kind: 'hard', misreads: ['CIOUDFIARE', 'CLOUDFLR', 'CL0UDFIAR'], yaw: 36, pitch: 3, w: 18, h: 5, color: '#f38020', textColor: '#ffffff', font: 'italic 800 1em system-ui' },
  { id: 'b-booth', text: 'BOOTH 14', kind: 'noise', yaw: 26, pitch: 13, w: 7, h: 2.5, color: '#1f2937', textColor: '#e5e7eb', font: '600 1em system-ui' },
  { id: 'b-supabase', text: 'supabase', kind: 'clean', yaw: -32, pitch: 2, w: 15, h: 4.5, color: '#1c1c1c', textColor: '#3ecf8e', font: '700 1em system-ui' },
  { id: 'b-apple', text: 'APPLE PIE STAND', kind: 'collide', yaw: -52, pitch: -6, w: 17, h: 4, color: '#fde68a', textColor: '#7c2d12', font: '700 1em Georgia, serif' },
  { id: 'b-nova', text: 'NOVA ROBOTICS', kind: 'unknown', yaw: 58, pitch: 0, w: 18, h: 5, color: '#0f766e', textColor: '#ecfeff', font: '700 1em system-ui' },
  { id: 'b-hf', text: 'Hugging Face', kind: 'clean', yaw: -74, pitch: 3, w: 17, h: 5, color: '#ffd21e', textColor: '#1f2937', font: '800 1em system-ui' },
  { id: 'b-linear', text: 'Linear', kind: 'clean', yaw: 80, pitch: 2, w: 13, h: 4.5, color: '#5e6ad2', textColor: '#ffffff', font: '600 1em system-ui' },
  { id: 'b-mongo', text: 'MongoDB', kind: 'hard', misreads: ['MonqoOB', 'ongoD', 'MnqoDB'], yaw: -98, pitch: 1, w: 15, h: 4.5, color: '#00684a', textColor: '#ffffff', font: '700 1em system-ui' },
  { id: 'b-vercel', text: '▲ Vercel', kind: 'clean', yaw: 104, pitch: 2, w: 14, h: 4.5, color: '#000000', textColor: '#ffffff', font: '700 1em system-ui' },
]
