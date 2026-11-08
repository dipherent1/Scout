<script setup lang="ts">
import { computed, ref } from 'vue'
import { useScout } from '../stores/scout'
import CompanyLogo from './CompanyLogo.vue'

const store = useScout()
const query = ref('')
const focused = ref(false)
const looking = ref(false)
const message = ref('')
const input = ref<HTMLInputElement>()

const results = computed(() => (query.value.trim() ? store.matcher.search(query.value, 6) : []))

function pick(i: number) {
  const c = results.value[i]
  if (!c) return
  store.select(c, 'search', 'half')
  query.value = ''
  input.value?.blur()
}

async function lookup() {
  const q = query.value.trim()
  if (!q) return
  looking.value = true
  message.value = ''
  const c = await store.lookupOnline(q)
  looking.value = false
  if (c) {
    store.select(c, 'search', 'half')
    query.value = ''
    input.value?.blur()
  } else {
    message.value = store.apiStatus === 'online' ? `Couldn't find "${q}".` : 'Online lookup needs the server.'
  }
}

function onBlur() {
  setTimeout(() => (focused.value = false), 150)
}

function prefill(text: string) {
  query.value = text
  input.value?.focus()
}

defineExpose({ prefill })
</script>

<template>
  <div class="search" @pointerdown.stop @pointerup.stop>
    <div class="field">
      <svg viewBox="0 0 24 24" width="16" height="16"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2" /><path d="m20 20-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
      <input
        ref="input"
        v-model="query"
        placeholder="Search companies"
        autocomplete="off"
        enterkeyhint="search"
        @focus="focused = true"
        @blur="onBlur"
        @keydown.enter.prevent="results.length ? pick(0) : lookup()"
      />
      <button v-if="query" class="clear" aria-label="Clear" @click="query = ''; message = ''">✕</button>
    </div>
    <ul v-if="focused && query.trim()" class="results">
      <li v-for="(c, i) in results" :key="c.domain" @mousedown.prevent="pick(i)">
        <CompanyLogo :company="c" :size="28" />
        <span class="name">{{ c.name }}</span>
        <span class="dot" :class="store.relevance(c)" />
      </li>
      <li class="online" @mousedown.prevent="lookup">
        <span v-if="looking">Looking up "{{ query }}"…</span>
        <span v-else>Look up "{{ query }}" online</span>
      </li>
      <li v-if="message" class="msg">{{ message }}</li>
    </ul>
  </div>
</template>

<style scoped>
.search {
  position: relative;
  flex: 1;
}
.field {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  height: 42px;
  border-radius: 999px;
  background: rgba(17, 20, 26, 0.72);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: #cbd5e1;
}
input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: 0;
  outline: 0;
  color: #f9fafb;
  font: 16px system-ui, sans-serif;
}
.clear {
  background: none;
  border: 0;
  color: #94a3b8;
  cursor: pointer;
}
.results {
  position: absolute;
  top: 48px;
  left: 0;
  right: 0;
  margin: 0;
  padding: 6px;
  list-style: none;
  background: rgba(15, 18, 24, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  z-index: 40;
}
li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  border-radius: 10px;
  color: #e5e7eb;
  cursor: pointer;
  font: 15px system-ui;
}
li:hover {
  background: rgba(255, 255, 255, 0.06);
}
.name {
  flex: 1;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: transparent;
}
.dot.high {
  background: #34d399;
}
.dot.medium {
  background: #fbbf24;
}
.online {
  color: #5eead4;
  font-size: 14px;
}
.msg {
  color: #94a3b8;
  font-size: 13px;
  cursor: default;
}
</style>
