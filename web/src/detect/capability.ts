/**
 * Startup capability check. Decides whether the device can run the on-device
 * detector (WebGPU or fast-enough WASM) or must fall back to tap-to-scan with
 * server OCR. The prototype always runs the simulated detector, but reports
 * what the real detector would get.
 */
export interface Capabilities {
  camera: boolean
  webgpu: boolean
  wasm: boolean
  wasmSimd: boolean
  workers: boolean
  videoFrameCallback: boolean
  deviceOrientation: boolean
  vibrate: boolean
  /** 'live' = continuous on-device detection; 'tap' = tap-to-scan fallback. */
  mode: 'live' | 'tap'
  backend: 'webgpu' | 'wasm' | 'none'
}

function wasmSimdSupported(): boolean {
  try {
    // Smallest module using a v128 instruction.
    return WebAssembly.validate(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]),
    )
  } catch {
    return false
  }
}

export async function detectCapabilities(): Promise<Capabilities> {
  const nav = navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }
  let webgpu = false
  if (nav.gpu) {
    try {
      webgpu = !!(await nav.gpu.requestAdapter())
    } catch {
      webgpu = false
    }
  }
  const wasm = typeof WebAssembly === 'object'
  const wasmSimd = wasm && wasmSimdSupported()
  const workers = typeof Worker !== 'undefined'
  const backend = webgpu ? 'webgpu' : wasmSimd ? 'wasm' : 'none'
  return {
    camera: !!navigator.mediaDevices?.getUserMedia,
    webgpu,
    wasm,
    wasmSimd,
    workers,
    videoFrameCallback: 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
    deviceOrientation: typeof DeviceOrientationEvent !== 'undefined',
    vibrate: typeof navigator.vibrate === 'function',
    mode: workers && backend !== 'none' ? 'live' : 'tap',
    backend,
  }
}
