import { reactive } from 'vue'

/** Live detection numbers. Shown in the tuning panel, never over the camera. */
export const liveStats = reactive({
  fps: 0,
  detFps: 0,
  inferMs: 0,
  tracks: 0,
  detector: '',
  paused: '',
  lowPower: false,
  cameraError: '',
  sensor: '',
})
