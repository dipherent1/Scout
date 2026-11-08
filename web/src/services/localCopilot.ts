import type { Company } from '../types'
import { sharedTerms } from '../match/embed'

/**
 * Offline copilot used when the API is unreachable or times out. It degrades
 * to a profile-based icebreaker from local data instead of showing an error
 * (scout.md, "Protections").
 */

function firstSentence(s: string): string {
  const m = s.match(/^.*?[.!?](\s|$)/)
  return (m ? m[0] : s).trim()
}

export function whyFits(bio: string, c: Company): string {
  if (!bio.trim()) return 'Add a short bio to see why this company fits you.'
  const shared = sharedTerms(bio, c)
  if (shared.length >= 2) return `Your background in ${shared[0]} and ${shared[1]} lines up with what ${c.name} works on.`
  if (shared.length === 1) return `You mentioned ${shared[0]}, which is central to ${c.name}'s work.`
  return `Not an obvious overlap with your bio; ask about ${c.focus_areas[0] ?? 'what they are building'} to find a connection.`
}

export function localIcebreaker(bio: string, c: Company): string {
  const shared = sharedTerms(bio, c)
  const hook = c.talking_points[0] ?? `what ${c.name} is focused on this year`
  const opener = shared.length
    ? `Hi! I work in ${shared[0]}, so I've been curious about ${hook.charAt(0).toLowerCase() + hook.slice(1)}. How does your team approach it?`
    : `Hi! I know ${c.name} from ${firstSentence(c.summary).replace(/^[^ ]+ /, '').replace(/\.$/, '').toLowerCase()}. What are you most excited about right now?`
  const points = c.talking_points.slice(0, 3).map((p) => `- ${p}`)
  const hiring = c.hiring_signals ? `\n\nHiring: ${c.hiring_signals}` : ''
  return `**Icebreaker:** ${opener}\n\n**Talking points:**\n${points.join('\n')}${hiring}`
}

export function localFollowup(bio: string, c: Company, note: string): string {
  const topic = c.talking_points[0]?.toLowerCase() ?? `${c.name}'s work`
  const me = bio.trim() ? ` As a reminder, I'm ${bio.trim().split(/[.\n]/)[0].replace(/^i am |^i'm /i, '').toLowerCase()}.` : ''
  const context = note.trim() ? ` I especially appreciated hearing about ${note.trim().replace(/\.$/, '')}.` : ''
  return `Hi, thanks for chatting at the ${c.name} booth today.${context} I'd love to keep the conversation going about ${topic}.${me} Would you have 15 minutes next week?`
}

export function localAnswer(c: Company, question: string): string {
  const q = question.toLowerCase()
  if (q.includes('news') || q.includes('recent')) {
    if (c.recent_news.length) return c.recent_news.map((n) => `- ${n.title} (${n.date})`).join('\n')
    return `I'm offline, so I can't search for fresh news about ${c.name}. Try asking what they shipped recently, or about ${c.products[0] ?? 'their main product'}.`
  }
  if (q.includes('hiring') || q.includes('job') || q.includes('role')) return c.hiring_signals || `No hiring info cached for ${c.name}.`
  if (q.includes('product')) return `${c.name}'s main products: ${c.products.join(', ')}.`
  return `${c.summary}\n\nGood angles: ${c.talking_points.slice(0, 2).join('; ')}.`
}

/** Emit text in small chunks so the offline path feels like the streamed one. */
export async function* streamText(text: string, signal?: AbortSignal): AsyncGenerator<string> {
  const parts = text.match(/\S+\s*/g) ?? [text]
  for (let i = 0; i < parts.length; i += 2) {
    if (signal?.aborted) return
    await new Promise((r) => setTimeout(r, 18))
    yield parts.slice(i, i + 2).join('')
  }
}
