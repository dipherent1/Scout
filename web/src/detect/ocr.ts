import { createWorker, PSM, type Worker as TessWorker } from 'tesseract.js'
import type { Detection, DetectionResult, Pose } from '../types'

export interface OcrSettings {
  /** Word confidence (0-100) below which a word is dropped. */
  minConf: number
  /** Longest side of the frame handed to OCR, in pixels. */
  maxSide: number
}

/**
 * Real on-device text detector for the live camera: Tesseract (WASM, in its
 * own worker) in sparse-text mode, which finds text anywhere in the frame.
 * Same surface as DetectorClient so the scan loop and tracker don't change.
 * Stand-in for the ONNX detector in scout.md step 2: fine for printed signs,
 * weaker on stylized logos.
 */
export class OcrDetector {
  private worker: TessWorker | null = null
  private frameId = 0
  private canvas = document.createElement('canvas')
  busy = true // until the model has loaded
  backend = 'loading OCR…'
  onResult: (r: DetectionResult) => void = () => {}

  constructor(public settings: OcrSettings) {
    void this.init()
  }

  private async init() {
    try {
      const w = await createWorker('eng')
      await w.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT })
      this.worker = w
      this.backend = 'tesseract'
      this.busy = false
    } catch (e) {
      console.error('[scout] OCR failed to load', e)
      this.backend = 'OCR failed to load'
    }
  }

  updateSettings(s: Partial<OcrSettings>) {
    Object.assign(this.settings, s)
  }

  /**
   * Run OCR on what the user actually sees: the part of the video that
   * `object-fit: cover` shows in a viewW x viewH box. Boxes come back
   * normalized to that view. Returns false if a frame is already in flight.
   */
  submit(pose: Pose, frameTime: number, video: HTMLVideoElement, viewW: number, viewH: number): boolean {
    if (this.busy || !this.worker) return false
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (!vw || !vh || !viewW || !viewH) return false
    this.busy = true
    const cover = Math.max(viewW / vw, viewH / vh)
    const sw = viewW / cover
    const sh = viewH / cover
    const sx = (vw - sw) / 2
    const sy = (vh - sh) / 2
    const scale = Math.min(1, this.settings.maxSide / Math.max(sw, sh))
    const cw = (this.canvas.width = Math.round(sw * scale))
    const ch = (this.canvas.height = Math.round(sh * scale))
    this.canvas.getContext('2d')!.drawImage(video, sx, sy, sw, sh, 0, 0, cw, ch)
    const id = ++this.frameId
    const start = performance.now()
    // Alternate binarization per frame. Global Otsu reads light-on-dark banners
    // but loses dark text on a white panel against a mid-gray background (the
    // printed-sign case); local Sauvola reads that one. The tracker merges hits
    // across frames, so each text only needs to be read by one of them.
    const worker = this.worker
    worker
      .setParameters({ thresholding_method: id % 2 ? '2' : '0' })
      .then(() => worker.recognize(this.canvas, {}, { blocks: true, text: false }))
      .then(({ data }) => {
        const detections: Detection[] = []
        for (const block of data.blocks ?? [])
          for (const para of block.paragraphs)
            for (const line of para.lines) {
              const words = line.words.filter((w) => w.confidence >= this.settings.minConf && /[a-z0-9]/i.test(w.text))
              const text = words.map((w) => w.text).join(' ').trim()
              if (text.replace(/[^a-z0-9]/gi, '').length < 2) continue
              const x0 = Math.min(...words.map((w) => w.bbox.x0))
              const y0 = Math.min(...words.map((w) => w.bbox.y0))
              const x1 = Math.max(...words.map((w) => w.bbox.x1))
              const y1 = Math.max(...words.map((w) => w.bbox.y1))
              // Tiny boxes are almost always texture noise.
              if (y1 - y0 < ch * 0.012) continue
              const conf = words.reduce((a, w) => a + w.confidence, 0) / words.length / 100
              detections.push({ x: x0 / cw, y: y0 / ch, w: (x1 - x0) / cw, h: (y1 - y0) / ch, text, conf })
            }
        this.busy = false
        this.onResult({ frameId: id, frameTime, pose, inferenceMs: performance.now() - start, detections })
      })
      .catch((e) => {
        console.warn('[scout] OCR frame failed', e)
        this.busy = false
      })
    return true
  }

  dispose() {
    void this.worker?.terminate()
    this.worker = null
  }
}
