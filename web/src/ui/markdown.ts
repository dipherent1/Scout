/** Tiny, safe markdown subset for model output: escapes HTML, then **bold**, [links](url), bullets, paragraphs. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function inline(s: string): string {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
}

export function renderMarkdown(md: string): string {
  const out: string[] = []
  let list: string[] = []
  const flush = () => {
    if (list.length) out.push(`<ul>${list.map((li) => `<li>${li}</li>`).join('')}</ul>`)
    list = []
  }
  for (const line of md.split('\n')) {
    const m = line.match(/^\s*[-*•]\s+(.*)$/)
    if (m) list.push(inline(m[1]))
    else {
      flush()
      if (line.trim()) out.push(`<p>${inline(line)}</p>`)
    }
  }
  flush()
  return out.join('')
}
