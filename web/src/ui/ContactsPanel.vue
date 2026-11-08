<script setup lang="ts">
import { useScout } from '../stores/scout'

defineEmits<{ close: [] }>()
const store = useScout()

function open(domain: string) {
  const c = store.companies.find((x) => x.domain === domain)
  if (c) store.select(c, 'search', 'full')
}

async function copyAll() {
  const text = store.contactList
    .map((n) => `${n.name} (${n.interest ?? 'no rating'})${n.note ? `\n  Note: ${n.note}` : ''}${n.followup ? `\n  Follow-up: ${n.followup}` : ''}`)
    .join('\n\n')
  await navigator.clipboard?.writeText(text)
}
</script>

<template>
  <div class="panel" @pointerdown.stop @pointerup.stop>
    <header>
      <h2>Who to contact</h2>
      <button v-if="store.contactList.length" class="link" @click="copyAll">Copy all</button>
      <button class="close" @click="$emit('close')">✕</button>
    </header>
    <div class="scroll">
      <p v-if="!store.contactList.length" class="empty">Mark interest or save a note on a company card and it shows up here, ranked for your end-of-day follow-ups.</p>
      <article v-for="n in store.contactList" :key="n.domain" @click="open(n.domain); $emit('close')">
        <div class="top">
          <strong>{{ n.name }}</strong>
          <span class="interest" :class="n.interest ?? ''">{{ n.interest ?? 'not rated' }}</span>
        </div>
        <p v-if="n.note">{{ n.note }}</p>
        <p v-if="n.followup" class="followup">{{ n.followup }}</p>
        <p v-else class="todo">No follow-up drafted yet</p>
      </article>
    </div>
  </div>
</template>

<style scoped>
.panel {
  position: absolute;
  inset: 0;
  z-index: 45;
  background: rgba(12, 15, 20, 0.98);
  color: #e5e7eb;
  display: flex;
  flex-direction: column;
  padding-top: env(safe-area-inset-top);
}
header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
h2 {
  flex: 1;
  margin: 0;
  font: 700 18px system-ui;
}
.scroll {
  overflow-y: auto;
  padding: 12px 16px 40px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 640px;
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
}
.empty {
  color: #94a3b8;
  line-height: 1.5;
}
article {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 14px;
  padding: 12px 14px;
  cursor: pointer;
}
.top {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.interest {
  font: 600 11px system-ui;
  text-transform: capitalize;
  padding: 3px 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  color: #94a3b8;
}
.interest.high {
  background: rgba(52, 211, 153, 0.15);
  color: #34d399;
}
.interest.medium {
  background: rgba(251, 191, 36, 0.15);
  color: #fbbf24;
}
p {
  margin: 6px 0 0;
  font-size: 14px;
  line-height: 1.4;
  color: #cbd5e1;
}
.followup {
  color: #e5e7eb;
  font-size: 13px;
  white-space: pre-wrap;
}
.todo {
  color: #64748b;
  font-size: 12px;
}
.link {
  background: none;
  border: 0;
  color: #5eead4;
  font: 600 13px system-ui;
  cursor: pointer;
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
</style>
