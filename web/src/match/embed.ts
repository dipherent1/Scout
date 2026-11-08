import type { Company, Relevance } from '../types'

/**
 * Lightweight on-device "embedding": a hashed bag of stemmed words with a small
 * synonym expansion, compared by cosine similarity. It is a stand-in for a real
 * sentence-embedding model (see open question on where embeddings run) and is
 * good enough to tune the green / amber / neutral coloring in the prototype.
 */

const DIM = 512

const STOP = new Set(
  'a an and are as at be by for from has have i in is it its looking me my of on or our that the to with we you your am im who want work working role roles years year experience interested'.split(
    ' ',
  ),
)

/** Expand a term into related terms so "backend" overlaps with "infrastructure" and "api". */
const SYNONYMS: Record<string, string[]> = {
  backend: ['api', 'infrastructure', 'server', 'database', 'distributed'],
  infra: ['infrastructure'],
  infrastructure: ['cloud', 'devops', 'reliability', 'distributed', 'platform'],
  sre: ['reliability', 'devops', 'infrastructure', 'monitoring'],
  devops: ['infrastructure', 'cloud', 'reliability'],
  frontend: ['web', 'ui', 'javascript', 'design', 'react'],
  react: ['frontend', 'javascript', 'web'],
  ml: ['machine', 'learning', 'ai', 'model'],
  ai: ['machine', 'learning', 'model', 'llm'],
  llm: ['ai', 'model', 'nlp'],
  data: ['analytics', 'sql', 'pipeline', 'warehouse'],
  fintech: ['payment', 'finance', 'banking'],
  payment: ['fintech', 'billing', 'finance'],
  design: ['ui', 'ux', 'product', 'frontend'],
  security: ['zero', 'trust', 'fraud', 'network'],
  mobile: ['ios', 'android', 'app'],
  ios: ['mobile', 'apple'],
  database: ['postgres', 'sql', 'backend', 'data'],
  postgres: ['database', 'sql'],
  python: ['backend', 'data', 'ml'],
  go: ['backend', 'infrastructure'],
  golang: ['backend', 'infrastructure'],
  rust: ['systems', 'infrastructure'],
  observability: ['monitoring', 'logs', 'metrics', 'tracing'],
}

function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3)
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y'
  if (w.length > 4 && w.endsWith('es') && !w.endsWith('ses')) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  if (w.length > 5 && w.endsWith('ed')) return w.slice(0, -2)
  return w
}

export function terms(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9+#\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem)
  return words
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function embed(text: string): Float32Array {
  const v = new Float32Array(DIM)
  for (const t of terms(text)) {
    v[hash(t) % DIM] += 1
    for (const syn of SYNONYMS[t] ?? []) v[hash(stem(syn)) % DIM] += 0.5
  }
  let norm = 0
  for (let i = 0; i < DIM; i++) norm += v[i] * v[i]
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < DIM; i++) v[i] /= norm
  return v
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

export function companyText(c: Company): string {
  // Focus areas count double: they are the most specific signal.
  return [c.name, c.summary, c.focus_areas.join(' '), c.focus_areas.join(' '), c.products.join(' '), c.hiring_signals].join(' ')
}

const cache = new WeakMap<Company, Float32Array>()

export function companyEmbedding(c: Company): Float32Array {
  let v = cache.get(c)
  if (!v) {
    v = embed(companyText(c))
    cache.set(c, v)
  }
  return v
}

export function relevanceScore(bioVec: Float32Array | null, c: Company): number {
  if (!bioVec) return 0
  return cosine(bioVec, companyEmbedding(c))
}

export function relevanceBand(score: number, green: number, amber: number): Relevance {
  if (score >= green) return 'high'
  if (score >= amber) return 'medium'
  return 'neutral'
}

/** Terms shared by the bio and the company, most specific first. Used for the "why this fits you" line. */
export function sharedTerms(bio: string, c: Company): string[] {
  const bioTerms = new Set<string>()
  for (const t of terms(bio)) {
    bioTerms.add(t)
    for (const s of SYNONYMS[t] ?? []) bioTerms.add(stem(s))
  }
  const hits: string[] = []
  for (const area of c.focus_areas) {
    const areaTerms = terms(area)
    if (areaTerms.some((t) => bioTerms.has(t))) hits.push(area)
  }
  return hits
}
