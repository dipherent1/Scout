import { ref, shallowRef } from 'vue'

/** Rear camera stream for the <video> element. Falls back to the simulated scene if unavailable. */
export function useCamera() {
  const stream = shallowRef<MediaStream | null>(null)
  const error = ref<string | null>(null)

  async function start(video: HTMLVideoElement) {
    error.value = null
    if (!navigator.mediaDevices?.getUserMedia) {
      error.value = window.isSecureContext ? 'No camera API in this browser' : 'Camera needs HTTPS'
      return false
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      })
      stream.value = s
      video.srcObject = s
      await video.play()
      return true
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return false
    }
  }

  function stop() {
    stream.value?.getTracks().forEach((t) => t.stop())
    stream.value = null
  }

  return { stream, error, start, stop }
}

/**
 * Grab the current video frame (or a region of it) as a downscaled JPEG,
 * base64 without the data: prefix. Images are downscaled on the phone and never stored.
 */
export function captureJpeg(video: HTMLVideoElement, maxSide = 768, region?: { x: number; y: number; w: number; h: number }): string | null {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return null
  const r = region ?? { x: 0, y: 0, w: 1, h: 1 }
  const sx = Math.max(0, r.x * vw)
  const sy = Math.max(0, r.y * vh)
  const sw = Math.min(vw - sx, r.w * vw)
  const sh = Math.min(vh - sy, r.h * vh)
  const scale = Math.min(1, maxSide / Math.max(sw, sh))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(sw * scale)
  canvas.height = Math.round(sh * scale)
  canvas.getContext('2d')!.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.8).split(',')[1] ?? null
}
