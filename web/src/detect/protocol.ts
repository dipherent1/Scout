import type { DetectionResult, Pose } from '../types'

/**
 * Messages between the main thread and the detector worker. The real ONNX
 * detector will use the same protocol, with `bitmap` carrying the video frame.
 */
export interface SimSettings {
  inferenceMs: number
  noiseDeg: number
  dropout: number
  fovH: number
  aspect: number
}

export type ToWorker =
  | { type: 'init'; settings: SimSettings }
  | { type: 'settings'; settings: Partial<SimSettings> }
  | { type: 'frame'; frameId: number; frameTime: number; pose: Pose; bitmap?: ImageBitmap }

export type FromWorker =
  | { type: 'ready'; backend: string }
  | ({ type: 'result' } & DetectionResult)
