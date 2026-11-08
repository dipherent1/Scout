/** Company record. Same shape as the server's CompanyRecord and the on-device bundle. */
export interface NewsItem {
  title: string
  url: string
  date: string
}

export interface Company {
  name: string
  domain: string
  aliases: string[]
  summary: string
  focus_areas: string[]
  products: string[]
  hiring_signals: string
  talking_points: string[]
  recent_news: NewsItem[]
  embedding: number[]
  confidence: number
  brand_color?: string
  logo_url?: string | null
}

/** Angular box in "world" coordinates (degrees of yaw/pitch, relative to the starting heading). */
export interface AngularBox {
  yaw: number
  pitch: number
  w: number
  h: number
}

export interface Pose {
  yaw: number
  pitch: number
}

/** One text region returned by the detector for a single frame. */
export interface Detection {
  /** Box in screen-normalized coordinates (0..1) for the frame it was detected in. */
  x: number
  y: number
  w: number
  h: number
  text: string
  /** Detector confidence that this is text (not the match score). */
  conf: number
}

export interface DetectionResult {
  frameId: number
  /** performance.now() when the frame was captured. */
  frameTime: number
  /** Camera pose when the frame was captured (for motion compensation). */
  pose: Pose
  inferenceMs: number
  detections: Detection[]
}

export interface MatchResult {
  company: Company
  score: number
}

export type SheetState = 'hidden' | 'peek' | 'half' | 'full'

export type Relevance = 'high' | 'medium' | 'neutral'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  sources?: { title: string; url: string }[]
  pending?: boolean
}

export type Interest = 'high' | 'medium' | 'low' | null

export interface CompanyNote {
  domain: string
  name: string
  note: string
  interest: Interest
  followup: string
  updatedAt: number
}
