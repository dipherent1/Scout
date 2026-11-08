/** Levenshtein distance with a single reusable row (fast enough for a few hundred names). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  const row = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) row[j] = j
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length]
}

/** Similarity in 0..1, like rapidfuzz `ratio` / 100. */
export function ratio(a: string, b: string): number {
  if (!a.length && !b.length) return 1
  const d = levenshtein(a, b)
  return 1 - d / Math.max(a.length, b.length)
}

/** Order-insensitive token comparison, like rapidfuzz `token_sort_ratio`. */
export function tokenSortRatio(a: string, b: string): number {
  const sa = a.split(' ').sort().join(' ')
  const sb = b.split(' ').sort().join(' ')
  return ratio(sa, sb)
}

/** Full-string similarity: the better of plain and token-sorted ratio. */
export function fullRatio(a: string, b: string): number {
  if (!a || !b) return 0
  return Math.max(ratio(a, b), tokenSortRatio(a, b))
}

/** Contiguous token windows of 1..maxLen tokens ("visit stripe booth" -> "visit", "stripe", "visit stripe", ...). */
export function ngrams(tokens: string[], maxLen: number): string[] {
  const out: string[] = []
  for (let n = 1; n <= Math.min(maxLen, tokens.length); n++) {
    for (let i = 0; i + n <= tokens.length; i++) out.push(tokens.slice(i, i + n).join(' '))
  }
  return out
}
