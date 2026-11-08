import type { Company } from '../types'

/**
 * Thin client for the FastAPI service (proxied under /api). Every call has a
 * timeout and returns null or throws ApiUnavailable so callers can degrade to
 * local data instead of showing an error.
 */

export class ApiUnavailable extends Error {}

const SESSION_KEY = 'scout.session'

export function sessionId(): string {
  let id = localStorage.getItem(SESSION_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(SESSION_KEY, id)
  }
  return id
}

function headers(): HeadersInit {
  return { 'Content-Type': 'application/json', 'X-Scout-Session': sessionId() }
}

export interface ScanCandidate {
  name: string
  domain: string
  confidence: number
  known: boolean
}

export interface ScanResponse {
  candidates: ScanCandidate[]
  source: 'database' | 'gemini' | 'none'
}

/** Server fallback for text the phone could not match. Sends text strings and/or a downscaled JPEG crop. */
export async function scan(texts: string[], imageB64?: string): Promise<ScanResponse | null> {
  try {
    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ texts, image_b64: imageB64 ?? null }),
      signal: AbortSignal.timeout(9000),
    })
    if (!res.ok) return null
    return (await res.json()) as ScanResponse
  } catch {
    return null
  }
}

export async function getCompany(key: string): Promise<Company | null> {
  try {
    const res = await fetch(`/api/company/${encodeURIComponent(key)}`, { headers: headers(), signal: AbortSignal.timeout(25000) })
    if (!res.ok) return null
    return (await res.json()) as Company
  } catch {
    return null
  }
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export type ChatMode = 'icebreaker' | 'chat' | 'followup'

export interface ChatEvent {
  type: 'token' | 'sources' | 'done' | 'error'
  text?: string
  sources?: { title: string; url: string }[]
}

/** POST /chat and parse the SSE stream. Throws ApiUnavailable if the stream cannot be opened. */
export async function* chatStream(
  body: { mode: ChatMode; profile: string; company: Company; messages: ChatTurn[]; note?: string },
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  let res: Response
  // The timeout only covers getting response headers. Once the stream is open,
  // the server handles slow models itself (it falls back before the first token).
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 6000)
  const onAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onAbort)
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { ...headers(), Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
  } catch (e) {
    throw new ApiUnavailable(String(e))
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok || !res.body) throw new ApiUnavailable(`HTTP ${res.status}`)

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += value
      // SSE events are separated by a blank line.
      let sep: number
      while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buffer.slice(0, sep)
        buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, '')
        let event = 'message'
        const data: string[] = []
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
        }
        if (!data.length) continue
        const payload = JSON.parse(data.join('\n'))
        if (event === 'token') yield { type: 'token', text: payload.text }
        else if (event === 'sources') yield { type: 'sources', sources: payload.sources }
        else if (event === 'error') yield { type: 'error', text: payload.message }
        else if (event === 'done') {
          yield { type: 'done' }
          return
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export async function health(): Promise<{ gemini: boolean } | null> {
  try {
    const res = await fetch('/api/health', { signal: AbortSignal.timeout(2500) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}
