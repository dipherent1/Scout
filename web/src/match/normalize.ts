const SUFFIXES = [
  'incorporated',
  'inc',
  'llc',
  'ltd',
  'limited',
  'corp',
  'corporation',
  'co',
  'gmbh',
  'plc',
  'sa',
  'ag',
  'hq',
]

const SUFFIX_RE = new RegExp(`\\b(${SUFFIXES.join('|')})\\b`, 'g')

/** Lowercase, strip punctuation and legal suffixes (Inc., LLC...), collapse whitespace. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(SUFFIX_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Common OCR confusions mapped to the letter they usually stand for. */
const OCR_FIX: Record<string, string> = { '0': 'o', '1': 'l', '5': 's', '8': 'b', '|': 'l', '$': 's' }

/**
 * Alternate readings that undo typical OCR digit/letter swaps. "1" is tried
 * as both "l" and "i" ("STR1PE" -> "stripe", "1INEAR" -> "linear").
 */
export function ocrFolds(text: string): string[] {
  if (!/[0158|$]/.test(text)) return []
  const asL = text.replace(/[0158|$]/g, (c) => OCR_FIX[c] ?? c)
  const asI = text.replace(/[0158|$]/g, (c) => (c === '1' ? 'i' : (OCR_FIX[c] ?? c)))
  return asL === asI ? [asL] : [asL, asI]
}
