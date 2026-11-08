import { describe, expect, it } from 'vitest'
import { Matcher } from './matcher'
import { normalize } from './normalize'
import { SAMPLE_COMPANIES } from './store'
import { BOOTHS } from '../detect/scene'
import { embed, relevanceScore } from './embed'

const m = new Matcher(SAMPLE_COMPANIES)
const LOCK = 0.85
const CHIP = 0.6

describe('normalize', () => {
  it('strips punctuation and legal suffixes', () => {
    expect(normalize('Stripe, Inc.')).toBe('stripe')
    expect(normalize('  DATADOG  HQ ')).toBe('datadog')
    expect(normalize('Café Société')).toBe('cafe societe')
  })
})

describe('matcher', () => {
  it('locks on clean banners', () => {
    for (const text of ['stripe', 'DATADOG', 'supabase', 'Hugging Face', 'Linear', '▲ Vercel']) {
      const r = m.match(text)
      expect(r.best!.score, text).toBeGreaterThanOrEqual(LOCK)
    }
  })

  it('maps clean banners to the right company', () => {
    expect(m.match('Hugging Face').best!.company.name).toBe('Hugging Face')
    expect(m.match('▲ Vercel').best!.company.name).toBe('Vercel')
  })

  it('undoes OCR digit swaps', () => {
    expect(m.match('STR1PE').best!.company.name).toBe('Stripe')
    expect(m.match('STR1PE').best!.score).toBeGreaterThanOrEqual(LOCK)
    expect(m.match('1INEAR').best!.company.name).toBe('Linear')
    expect(m.match('5upabase').best!.score).toBeGreaterThanOrEqual(LOCK)
  })

  it('puts garbled stylized banners in the chip band', () => {
    for (const b of BOOTHS.filter((x) => x.kind === 'hard')) {
      for (const text of b.misreads!) {
        const r = m.match(text)
        expect(r.best!.score, text).toBeGreaterThanOrEqual(CHIP)
        expect(r.best!.company.name.toLowerCase(), text).toBe(b.text.toLowerCase())
      }
    }
  })

  it('never locks a common word embedded in other text', () => {
    const r = m.match('APPLE PIE STAND')
    expect(r.best!.company.name).toBe('Apple')
    expect(r.best!.score).toBeLessThan(LOCK)
    expect(r.best!.score).toBeGreaterThanOrEqual(CHIP)
  })

  it('locks when a distinctive name appears inside a longer line', () => {
    expect(m.match('Visit Datadog at booth 4').best!.score).toBeGreaterThanOrEqual(LOCK)
  })

  it('matches nothing for noise and unknown companies', () => {
    for (const text of ['FREE COFFEE', 'BOOTH 14', 'NOVA ROBOTICS', 'WELCOME']) {
      expect(m.match(text).best?.score ?? 0, text).toBeLessThan(CHIP)
    }
  })

  it('search finds by prefix', () => {
    expect(m.search('data')[0].name).toBe('Datadog')
    expect(m.search('hug')[0].name).toBe('Hugging Face')
  })

  it('matches in well under 50 ms', () => {
    const t0 = performance.now()
    for (let i = 0; i < 100; i++) m.match('CIOUDFIARE')
    expect((performance.now() - t0) / 100).toBeLessThan(5)
  })
})

describe('relevance', () => {
  it('ranks infrastructure companies above design tools for a backend bio', () => {
    const bio = embed('Backend engineer looking for infrastructure roles, Python and Go')
    const byName = (n: string) => relevanceScore(bio, SAMPLE_COMPANIES.find((c) => c.name === n)!)
    expect(byName('Datadog')).toBeGreaterThan(byName('Figma'))
    expect(byName('Cloudflare')).toBeGreaterThan(byName('Linear'))
  })
})
