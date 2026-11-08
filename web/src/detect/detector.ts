import type { DetectionResult, Pose } from '../types'
import type { FromWorker, SimSettings, ToWorker } from './protocol'

/**
 * Main-thread handle on the detector worker. Only one frame is in flight at a
 * time: if the worker is busy, new frames are skipped rather than queued, so
 * detections never fall further and further behind the camera.
 */
export class DetectorClient {
  private worker: Worker
  private frameId = 0
  busy = false
  backend = 'loading'
  onResult: (r: DetectionResult) => void = () => {}

  constructor(settings: SimSettings) {
    this.worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      const msg = ev.data
      if (msg.type === 'ready') this.backend = msg.backend
      else if (msg.type === 'result') {
        this.busy = false
        const { type: _t, ...result } = msg
        this.onResult(result)
      }
    }
    this.send({ type: 'init', settings })
  }

  private send(msg: ToWorker, transfer: Transferable[] = []) {
    this.worker.postMessage(msg, transfer)
  }

  updateSettings(settings: Partial<SimSettings>) {
    this.send({ type: 'settings', settings })
  }

  /** Returns false if a frame is already in flight. */
  submit(pose: Pose, frameTime: number, bitmap?: ImageBitmap): boolean {
    if (this.busy) {
      bitmap?.close()
      return false
    }
    this.busy = true
    this.send({ type: 'frame', frameId: ++this.frameId, frameTime, pose, bitmap }, bitmap ? [bitmap] : [])
    return true
  }

  dispose() {
    this.worker.terminate()
  }
}
