import type { Company, MatchResult } from '../types'
import { fullRatio, ngrams } from './fuzzy'
import { normalize, ocrFolds } from './normalize'

/**
 * Company names that are also ordinary words. When one of these only appears
 * inside a longer string ("apple pie stand", "wheelchair ramp"), the score is
 * capped below the lock threshold so the user sees a chip instead of a false lock.
 */
const COMMON_WORDS = new Set([
  'apple', 'notion', 'ramp', 'linear', 'stripe', 'snowflake', 'square', 'block', 'box',
  'slack', 'zoom', 'signal', 'shopify', 'oracle', 'amazon', 'meta', 'target', 'gap',
])

const AMBIGUOUS_CAP = 0.78
const SUBSTRING_PENALTY = 0.96

interface IndexEntry {
  key: string
  tokens: number
  company: Company
  common: boolean
}

export interface MatchOutput {
  best: MatchResult | null
  /** Top companies scoring at or above `minScore`, best first (max 3). */
  candidates: MatchResult[]
}

function domainStem(domain: string): string {
  return normalize(domain.replace(/^www\./, '').split('.')[0] ?? '')
}

export class Matcher {
  private entries: IndexEntry[] = []

  constructor(companies: Company[] = []) {
    this.setCompanies(companies)
  }

  setCompanies(companies: Company[]) {
    const entries: IndexEntry[] = []
    for (const company of companies) {
      const keys = new Set<string>()
      keys.add(normalize(company.name))
      for (const a of company.aliases) keys.add(normalize(a))
      const stem = domainStem(company.domain)
      if (stem.length >= 4) keys.add(stem)
      for (const key of keys) {
        if (!key) continue
        entries.push({ key, tokens: key.split(' ').length, company, common: COMMON_WORDS.has(key) })
      }
    }
    this.entries = entries
  }

  /** Score one key against the query; handles OCR-folded text and names embedded in longer lines. */
  private scoreEntry(e: IndexEntry, variants: { q: string; tokens: string[] }[]): number {
    let best = 0
    for (const { q, tokens } of variants) {
      if (e.key.length <= 2) {
        if (q === e.key) best = Math.max(best, 1)
        continue
      }
      best = Math.max(best, fullRatio(q, e.key))
      if (tokens.length > e.tokens) {
        for (const gram of ngrams(tokens, e.tokens + 1)) {
          if (gram.length < 3) continue
          let s = fullRatio(gram, e.key) * SUBSTRING_PENALTY
          if (e.common) s = Math.min(s, AMBIGUOUS_CAP)
          if (s > best) best = s
        }
      }
    }
    return best
  }

  match(text: string, minScore = 0.6): MatchOutput {
    const q = normalize(text)
    if (q.replace(/\s/g, '').length < 2) return { best: null, candidates: [] }
    const variants = [{ q, tokens: q.split(' ') }]
    for (const folded of ocrFolds(text)) {
      const qf = normalize(folded)
      if (!variants.some((v) => v.q === qf)) variants.push({ q: qf, tokens: qf.split(' ') })
    }

    const byCompany = new Map<Company, number>()
    for (const e of this.entries) {
      const s = this.scoreEntry(e, variants)
      if (s > (byCompany.get(e.company) ?? 0)) byCompany.set(e.company, s)
    }
    const ranked = [...byCompany.entries()]
      .map(([company, score]) => ({ company, score }))
      .sort((a, b) => b.score - a.score)
    const best = ranked[0] && ranked[0].score > 0 ? ranked[0] : null
    return { best, candidates: ranked.filter((r) => r.score >= minScore).slice(0, 3) }
  }

  /** Manual search: prefix and substring hits first, then fuzzy. */
  search(query: string, limit = 6): Company[] {
    const q = normalize(query)
    if (!q) return []
    const scored = new Map<Company, number>()
    for (const e of this.entries) {
      let s = 0
      if (e.key.startsWith(q)) s = 2 - e.key.length / 100
      else if (e.key.includes(q)) s = 1.5
      else s = fullRatio(q, e.key)
      if (s > (scored.get(e.company) ?? 0)) scored.set(e.company, s)
    }
    return [...scored.entries()]
      .filter(([, s]) => s >= 0.5)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([c]) => c)
  }
}
