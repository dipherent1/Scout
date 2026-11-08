<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useScout } from '../stores/scout'
import { whyFits } from '../services/localCopilot'
import type { SheetState } from '../types'
import CompanyLogo from './CompanyLogo.vue'
import { renderMarkdown } from './markdown'

const store = useScout()
const company = computed(() => store.selected)
const messages = computed(() => (company.value ? (store.chats.get(company.value.domain) ?? []) : []))
const icebreaker = computed(() => messages.value[0])
const isStreaming = computed(() => !!company.value && store.streaming.has(company.value.domain))
const note = computed(() => (company.value ? store.notes[company.value.domain] : undefined))
const fit = computed(() => (company.value ? whyFits(store.bio, company.value) : ''))
const relevance = computed(() => (company.value ? store.relevance(company.value) : 'neutral'))
const relevanceLabel = computed(() => ({ high: 'Strong fit', medium: 'Some fit', neutral: '' })[relevance.value])

const question = ref('')
const noteDraft = ref('')
const thread = ref<HTMLDivElement>()
const copied = ref(false)

watch(
  company,
  (c) => {
    noteDraft.value = c ? (store.notes[c.domain]?.note ?? '') : ''
    question.value = ''
  },
  { immediate: true },
)

watch(
  () => messages.value.map((m) => m.content.length).join(),
  async () => {
    await nextTick()
    thread.value?.scrollTo({ top: thread.value.scrollHeight, behavior: 'smooth' })
  },
)

// ---- Drag to resize ----
const HEIGHTS: Record<SheetState, () => number> = {
  hidden: () => 0,
  peek: () => 104,
  half: () => Math.round(window.innerHeight * 0.55),
  full: () => Math.round(window.innerHeight * 0.92),
}
const dragH = ref<number | null>(null)
let startY = 0
let startH = 0
let moved = false

const height = computed(() => dragH.value ?? HEIGHTS[store.sheet]())

function onHandleDown(e: PointerEvent) {
  startY = e.clientY
  startH = height.value
  moved = false
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}
function onHandleMove(e: PointerEvent) {
  if (!(e.buttons & 1) && e.pointerType === 'mouse') return
  if (startY === 0) return
  const dy = startY - e.clientY
  if (Math.abs(dy) > 4) moved = true
  if (moved) dragH.value = Math.max(40, Math.min(HEIGHTS.full(), startH + dy))
}
function onHandleUp() {
  const h = dragH.value
  startY = 0
  dragH.value = null
  if (!moved || h === null) {
    // Tap cycles peek -> half -> full -> half.
    store.setSheet(store.sheet === 'peek' ? 'half' : store.sheet === 'half' ? 'full' : 'half')
    return
  }
  const order: SheetState[] = ['hidden', 'peek', 'half', 'full']
  let best: SheetState = 'peek'
  let bestD = Infinity
  for (const s of order) {
    const d = Math.abs(HEIGHTS[s]() - h)
    if (d < bestD) {
      bestD = d
      best = s
    }
  }
  store.setSheet(best)
}

function send(text?: string) {
  const q = (text ?? question.value).trim()
  if (!q || !company.value) return
  store.ask(company.value, q)
  question.value = ''
  if (store.sheet !== 'full') store.setSheet('full')
}

function saveNote() {
  if (company.value) store.saveNote(company.value, noteDraft.value)
}

async function copyFollowup() {
  if (!note.value?.followup) return
  await navigator.clipboard?.writeText(note.value.followup)
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

const QUICK = ['What recent news should I mention?', 'Are they hiring for my background?', 'What should I ask an engineer here?']
</script>

<template>
  <section
    v-if="company"
    class="sheet"
    :class="[store.sheet, { dragging: dragH !== null }]"
    :style="{ height: height + 'px' }"
    @pointerdown.stop
    @pointerup.stop
  >
    <div class="grab" @pointerdown="onHandleDown" @pointermove="onHandleMove" @pointerup="onHandleUp" @pointercancel="onHandleUp">
      <div class="handle" />
      <header>
        <CompanyLogo :company="company" />
        <div class="title">
          <h2>{{ company.name }}</h2>
          <span class="domain">{{ company.domain }}</span>
        </div>
        <span v-if="relevanceLabel" class="fit" :class="relevance">{{ relevanceLabel }}</span>
        <button class="close" aria-label="Close" @pointerdown.stop @click.stop="store.setSheet('hidden')">✕</button>
      </header>
    </div>

    <div class="body">
      <p v-if="company.summary" class="summary">{{ company.summary }}</p>
      <p v-else class="summary muted">Loading summary…</p>
      <p class="why"><strong>Why this fits you:</strong> {{ fit }}</p>

      <div v-if="store.sheet === 'half' && icebreaker" class="preview" @click="store.setSheet('full')">
        <div class="md" v-html="renderMarkdown(icebreaker.content || '…')" />
        <span class="open">Open copilot ↑</span>
      </div>

      <template v-if="store.sheet === 'full'">
        <div ref="thread" class="thread">
          <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
            <div class="md" v-html="renderMarkdown(m.content || (m.pending ? '…' : ''))" />
            <div v-if="m.sources?.length" class="sources">
              <a v-for="s in m.sources" :key="s.url" :href="s.url" target="_blank" rel="noopener noreferrer">{{ s.title || s.url }}</a>
            </div>
          </div>
        </div>
        <div class="quick">
          <button v-for="q in QUICK" :key="q" class="chip" :disabled="isStreaming" @click="send(q)">{{ q }}</button>
        </div>
        <form class="ask" @submit.prevent="send()">
          <input v-model="question" placeholder="Ask about this company…" enterkeyhint="send" />
          <button type="submit" :disabled="!question.trim() || isStreaming">Ask</button>
        </form>

        <div class="after">
          <h3>After the booth</h3>
          <div class="interest">
            <span>Interest</span>
            <button v-for="lvl in ['high', 'medium', 'low'] as const" :key="lvl" :class="{ on: note?.interest === lvl }" @click="store.setInterest(company, lvl)">
              {{ lvl }}
            </button>
          </div>
          <textarea v-model="noteDraft" rows="2" placeholder="Note: who you met, what you talked about" @blur="saveNote" />
          <div class="row">
            <button class="secondary" :disabled="isStreaming" @click="saveNote(); store.draftFollowup(company)">Draft follow-up</button>
            <button v-if="note?.followup" class="secondary" @click="copyFollowup">{{ copied ? 'Copied' : 'Copy' }}</button>
          </div>
          <p v-if="note?.followup" class="followup">{{ note.followup }}</p>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.sheet {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  background: rgba(15, 18, 24, 0.94);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  border-top-left-radius: 22px;
  border-top-right-radius: 22px;
  box-shadow: 0 -10px 40px rgba(0, 0, 0, 0.45);
  color: #e5e7eb;
  transition: height 0.38s cubic-bezier(0.2, 1.2, 0.3, 1);
  padding-bottom: env(safe-area-inset-bottom);
  overflow: hidden;
  animation: rise 0.36s cubic-bezier(0.2, 1.25, 0.3, 1);
}
.sheet.dragging {
  transition: none;
}
.sheet.hidden {
  display: none;
}
@keyframes rise {
  from {
    transform: translateY(100%);
  }
}
.grab {
  padding: 8px 16px 10px;
  touch-action: none;
  cursor: grab;
}
.handle {
  width: 38px;
  height: 5px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.25);
  margin: 0 auto 10px;
}
header {
  display: flex;
  align-items: center;
  gap: 12px;
}
.title {
  flex: 1;
  min-width: 0;
}
h2 {
  margin: 0;
  font: 700 19px system-ui, sans-serif;
  color: #f9fafb;
}
.domain {
  font-size: 12px;
  color: #94a3b8;
}
.fit {
  font: 600 11px system-ui;
  padding: 4px 8px;
  border-radius: 999px;
}
.fit.high {
  background: rgba(52, 211, 153, 0.15);
  color: #34d399;
}
.fit.medium {
  background: rgba(251, 191, 36, 0.15);
  color: #fbbf24;
}
.close {
  background: rgba(255, 255, 255, 0.08);
  border: 0;
  color: #cbd5e1;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  cursor: pointer;
}
.body {
  flex: 1;
  overflow-y: auto;
  padding: 0 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.summary {
  margin: 4px 0 0;
  line-height: 1.45;
  font-size: 15px;
  animation: fade 0.3s 0.08s both;
}
.why {
  margin: 0;
  font-size: 14px;
  line-height: 1.4;
  color: #cbd5e1;
  animation: fade 0.3s 0.16s both;
}
.why strong {
  color: #5eead4;
}
.muted {
  color: #64748b;
}
@keyframes fade {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}
.preview {
  background: rgba(94, 234, 212, 0.07);
  border: 1px solid rgba(94, 234, 212, 0.2);
  border-radius: 14px;
  padding: 10px 12px;
  cursor: pointer;
  font-size: 14px;
  max-height: 160px;
  overflow: hidden;
  position: relative;
}
.preview .open {
  display: block;
  margin-top: 4px;
  color: #5eead4;
  font: 600 12px system-ui;
}
.md :deep(p) {
  margin: 0 0 6px;
  line-height: 1.45;
}
.md :deep(ul) {
  margin: 0 0 6px;
  padding-left: 18px;
}
.md :deep(li) {
  margin-bottom: 3px;
  line-height: 1.4;
}
.md :deep(a) {
  color: #5eead4;
}
.thread {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 14px;
}
.msg {
  padding: 9px 12px;
  border-radius: 14px;
  max-width: 92%;
}
.msg.assistant {
  background: rgba(255, 255, 255, 0.06);
  align-self: flex-start;
}
.msg.user {
  background: #134e4a;
  align-self: flex-end;
}
.sources {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}
.sources a {
  font-size: 11px;
  color: #5eead4;
  background: rgba(94, 234, 212, 0.08);
  padding: 3px 7px;
  border-radius: 6px;
  text-decoration: none;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.quick {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 2px;
}
.chip {
  flex: none;
  padding: 7px 11px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.05);
  color: #e5e7eb;
  font: 500 12px system-ui;
  cursor: pointer;
}
.ask {
  display: flex;
  gap: 8px;
}
input,
textarea {
  flex: 1;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 12px;
  color: #f9fafb;
  padding: 10px 12px;
  font: 15px system-ui;
  resize: none;
}
.ask button,
.secondary {
  border: 0;
  border-radius: 12px;
  padding: 0 14px;
  background: #5eead4;
  color: #042f2e;
  font: 700 14px system-ui;
  cursor: pointer;
}
.secondary {
  padding: 9px 14px;
  background: rgba(255, 255, 255, 0.1);
  color: #f9fafb;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.after {
  margin-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
h3 {
  margin: 0;
  font: 700 13px system-ui;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #94a3b8;
}
.interest {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 13px;
}
.interest span {
  margin-right: 4px;
  color: #94a3b8;
}
.interest button {
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: transparent;
  color: #e5e7eb;
  border-radius: 999px;
  padding: 5px 11px;
  text-transform: capitalize;
  cursor: pointer;
}
.interest button.on {
  background: #5eead4;
  color: #042f2e;
  border-color: #5eead4;
}
.row {
  display: flex;
  gap: 8px;
}
.followup {
  margin: 0;
  font-size: 14px;
  line-height: 1.45;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 12px;
  padding: 10px 12px;
  white-space: pre-wrap;
}
</style>
