import { defineStore } from 'pinia'
import { computed, markRaw, reactive, ref, shallowRef, watch } from 'vue'
import { tuning } from '../config'
import { embed, relevanceBand, relevanceScore } from '../match/embed'
import { Matcher } from '../match/matcher'
import { cacheCompany, loadCachedBundle, refreshBundle, SAMPLE_COMPANIES } from '../match/store'
import { ApiUnavailable, chatStream, getCompany, health, type ChatMode, type ChatTurn } from '../services/api'
import { localAnswer, localFollowup, localIcebreaker, streamText } from '../services/localCopilot'
import type { ChatMessage, Company, CompanyNote, Interest, Relevance, SheetState } from '../types'

const EVENT = 'sample'
const PROFILE_KEY = 'scout.profile'
const NOTES_KEY = 'scout.notes.v1'
const METRICS_KEY = 'scout.metrics.v1'

export interface Metrics {
  scanLocks: number
  chipPicks: number
  manualSearches: number
  serverFallbacks: number
  cardsOpened: number
  chatsFromIcebreaker: number
  followupsDrafted: number
  notesSaved: number
  lockToCardMs: number[]
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback
  } catch {
    return fallback
  }
}

export const useScout = defineStore('scout', () => {
  // ---- Profile (stays in the browser) ----
  const bio = ref(localStorage.getItem(PROFILE_KEY) ?? '')
  const onboardingOpen = ref(localStorage.getItem(PROFILE_KEY) === null)
  watch(bio, (b) => localStorage.setItem(PROFILE_KEY, b))
  const bioVec = computed(() => (bio.value.trim() ? embed(bio.value) : null))

  // ---- Exhibitor bundle ----
  const companies = shallowRef<Company[]>(SAMPLE_COMPANIES)
  const bundleSource = ref<'sample' | 'indexeddb' | 'server'>('sample')
  const matcher = markRaw(new Matcher(SAMPLE_COMPANIES))
  function setCompanies(list: Company[]) {
    companies.value = list
    matcher.setCompanies(list)
  }

  const apiStatus = ref<'unknown' | 'online' | 'offline'>('unknown')
  const geminiEnabled = ref(false)

  async function init() {
    const cached = await loadCachedBundle(EVENT)
    setCompanies(cached.companies)
    bundleSource.value = cached.source
    const h = await health()
    apiStatus.value = h ? 'online' : 'offline'
    geminiEnabled.value = !!h?.gemini
    if (h) {
      const fresh = await refreshBundle(EVENT)
      if (fresh) {
        setCompanies(fresh)
        bundleSource.value = 'server'
      }
    }
  }

  /** Add a company enriched by the server to the local bundle so the next scan is instant. */
  function addCompany(c: Company) {
    const list = [...companies.value.filter((x) => x.domain !== c.domain), c]
    setCompanies(list)
    void cacheCompany(EVENT, c, companies.value)
  }

  async function lookupOnline(query: string): Promise<Company | null> {
    const c = await getCompany(query)
    if (c) addCompany(c)
    return c
  }

  // ---- Relevance coloring ----
  const relevanceCache = computed(() => {
    const m = new Map<string, { score: number; band: Relevance }>()
    for (const c of companies.value) {
      const score = relevanceScore(bioVec.value, c)
      m.set(c.domain, { score, band: bioVec.value ? relevanceBand(score, tuning.greenThreshold, tuning.amberThreshold) : 'neutral' })
    }
    return m
  })
  function relevance(c: Company): Relevance {
    return relevanceCache.value.get(c.domain)?.band ?? 'neutral'
  }
  function relevanceValue(c: Company): number {
    return relevanceCache.value.get(c.domain)?.score ?? 0
  }

  // ---- Selection and bottom sheet ----
  const selected = shallowRef<Company | null>(null)
  const sheet = ref<SheetState>('hidden')
  const dismissedAt = reactive(new Map<string, number>())
  let lockTime = 0

  function select(c: Company, how: 'scan' | 'chip' | 'search', state: SheetState = 'peek') {
    if (how === 'scan') metrics.scanLocks++
    if (how === 'chip') metrics.chipPicks++
    if (how === 'search') metrics.manualSearches++
    if (selected.value !== c) lockTime = performance.now()
    selected.value = c
    if (sheet.value === 'hidden' || state !== 'peek') sheet.value = state
    prefetchIcebreaker(c)
  }

  function setSheet(state: SheetState) {
    if (state === 'half' && (sheet.value === 'peek' || sheet.value === 'hidden') && lockTime) {
      metrics.cardsOpened++
      metrics.lockToCardMs = [...metrics.lockToCardMs.slice(-49), Math.round(performance.now() - lockTime)]
    }
    if (state === 'hidden' && selected.value) dismissedAt.set(selected.value.domain, performance.now())
    sheet.value = state
  }

  /** Recently dismissed companies don't pop the card again on the next lock. */
  function recentlyDismissed(c: Company): boolean {
    const t = dismissedAt.get(c.domain)
    return t !== undefined && performance.now() - t < 15_000
  }

  // ---- Copilot chat ----
  const chats = reactive(new Map<string, ChatMessage[]>())
  const streaming = reactive(new Set<string>())

  async function runStream(c: Company, mode: ChatMode, history: ChatTurn[], fallback: () => string, onText?: (full: string) => void) {
    const list = chats.get(c.domain) ?? []
    if (!chats.has(c.domain)) chats.set(c.domain, list)
    const msg = reactive<ChatMessage>({ role: 'assistant', content: '', pending: true })
    if (mode !== 'followup') list.push(msg)
    streaming.add(c.domain)
    try {
      try {
        if (apiStatus.value !== 'online') throw new ApiUnavailable('offline')
        const note = notes[c.domain]?.note
        for await (const ev of chatStream({ mode, profile: bio.value, company: c, messages: history, note })) {
          if (ev.type === 'token' && ev.text) {
            msg.content += ev.text
            onText?.(msg.content)
          } else if (ev.type === 'sources') msg.sources = ev.sources
          else if (ev.type === 'error') throw new ApiUnavailable(ev.text)
        }
        if (!msg.content) throw new ApiUnavailable('empty')
      } catch (e) {
        if (!(e instanceof ApiUnavailable) && !(e instanceof TypeError)) console.warn(e)
        if (msg.content) return // partial answer is better than restarting
        for await (const chunk of streamText(fallback())) {
          msg.content += chunk
          onText?.(msg.content)
        }
      }
    } finally {
      msg.pending = false
      streaming.delete(c.domain)
    }
  }

  /** Start the icebreaker as soon as a box locks, so it's ready when the user taps. */
  function prefetchIcebreaker(c: Company) {
    if (chats.get(c.domain)?.length) return
    void runStream(c, 'icebreaker', [], () => localIcebreaker(bio.value, c))
  }

  function ask(c: Company, question: string) {
    const list = chats.get(c.domain) ?? []
    if (!chats.has(c.domain)) chats.set(c.domain, list)
    if (list.length === 1 && list[0].role === 'assistant') metrics.chatsFromIcebreaker++
    const history: ChatTurn[] = list.filter((m) => !m.pending).map((m) => ({ role: m.role, content: m.content }))
    list.push({ role: 'user', content: question })
    history.push({ role: 'user', content: question })
    void runStream(c, 'chat', history.slice(-10), () => localAnswer(c, question))
  }

  // ---- Notes and follow-ups (localStorage in v1) ----
  const notes = reactive<Record<string, CompanyNote>>(loadJson(NOTES_KEY, {}))
  watch(notes, (n) => localStorage.setItem(NOTES_KEY, JSON.stringify(n)), { deep: true })

  function noteFor(c: Company): CompanyNote {
    if (!notes[c.domain]) notes[c.domain] = { domain: c.domain, name: c.name, note: '', interest: null, followup: '', updatedAt: Date.now() }
    return notes[c.domain]
  }

  function setInterest(c: Company, interest: Interest) {
    const n = noteFor(c)
    n.interest = n.interest === interest ? null : interest
    n.updatedAt = Date.now()
  }

  function saveNote(c: Company, text: string) {
    const n = noteFor(c)
    if (text !== n.note) metrics.notesSaved++
    n.note = text
    n.updatedAt = Date.now()
  }

  async function draftFollowup(c: Company) {
    const n = noteFor(c)
    metrics.followupsDrafted++
    n.followup = ''
    await runStream(c, 'followup', [], () => localFollowup(bio.value, c, n.note), (full) => {
      n.followup = full
    })
    n.updatedAt = Date.now()
  }

  const contactList = computed(() => {
    const rank = { high: 0, medium: 1, low: 2 } as const
    return Object.values(notes)
      .filter((n) => n.interest || n.note || n.followup)
      .sort((a, b) => (rank[a.interest ?? 'low'] ?? 3) - (rank[b.interest ?? 'low'] ?? 3) || b.updatedAt - a.updatedAt)
  })

  // ---- Metrics from day one ----
  const metrics = reactive<Metrics>(
    loadJson<Metrics>(METRICS_KEY, {
      scanLocks: 0,
      chipPicks: 0,
      manualSearches: 0,
      serverFallbacks: 0,
      cardsOpened: 0,
      chatsFromIcebreaker: 0,
      followupsDrafted: 0,
      notesSaved: 0,
      lockToCardMs: [],
    }),
  )
  watch(metrics, (m) => localStorage.setItem(METRICS_KEY, JSON.stringify(m)), { deep: true })

  return {
    bio,
    bioVec,
    onboardingOpen,
    companies,
    bundleSource,
    matcher,
    apiStatus,
    geminiEnabled,
    init,
    addCompany,
    lookupOnline,
    relevance,
    relevanceValue,
    selected,
    sheet,
    select,
    setSheet,
    recentlyDismissed,
    chats,
    streaming,
    prefetchIcebreaker,
    ask,
    notes,
    noteFor,
    setInterest,
    saveNote,
    draftFollowup,
    contactList,
    metrics,
  }
})
