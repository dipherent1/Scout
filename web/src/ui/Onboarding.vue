<script setup lang="ts">
import { ref } from 'vue'
import { useScout } from '../stores/scout'

const store = useScout()
const draft = ref(store.bio)

const EXAMPLES = [
  'Backend engineer, 4 years of Python and Go, looking for infrastructure or platform roles.',
  'Frontend developer into React and design systems, curious about developer tools.',
  'ML student working on LLMs and data pipelines, looking for an internship.',
]

function save() {
  store.bio = draft.value.trim()
  store.onboardingOpen = false
}
function skip() {
  if (!localStorage.getItem('scout.profile')) store.bio = ''
  store.onboardingOpen = false
}
</script>

<template>
  <div class="backdrop" @pointerdown.stop @pointerup.stop>
    <div class="card">
      <h2>What are you looking for?</h2>
      <p>Paste a short bio, resume text or a few bullets. Scout uses it to color booths by fit and to write your icebreakers. It stays in this browser.</p>
      <textarea v-model="draft" rows="5" placeholder="e.g. Backend engineer looking for infrastructure roles" />
      <div class="examples">
        <button v-for="e in EXAMPLES" :key="e" class="example" @click="draft = e">{{ e }}</button>
      </div>
      <div class="row">
        <button class="ghost" @click="skip">Skip</button>
        <button class="primary" :disabled="!draft.trim()" @click="save">Save</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: absolute;
  inset: 0;
  z-index: 50;
  background: rgba(5, 7, 10, 0.7);
  backdrop-filter: blur(6px);
  display: grid;
  place-items: end center;
  padding: 12px;
}
.card {
  width: 100%;
  max-width: 480px;
  background: #11151c;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 22px;
  padding: 20px;
  color: #e5e7eb;
  margin-bottom: env(safe-area-inset-bottom);
  animation: rise 0.35s cubic-bezier(0.2, 1.2, 0.3, 1);
}
@keyframes rise {
  from {
    transform: translateY(40px);
    opacity: 0;
  }
}
h2 {
  margin: 0 0 6px;
  font: 700 20px system-ui;
}
p {
  margin: 0 0 12px;
  color: #94a3b8;
  font-size: 14px;
  line-height: 1.45;
}
textarea {
  width: 100%;
  box-sizing: border-box;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 12px;
  color: #f9fafb;
  padding: 10px 12px;
  font: 15px/1.4 system-ui;
  resize: vertical;
}
.examples {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 10px 0 14px;
}
.example {
  text-align: left;
  background: rgba(94, 234, 212, 0.06);
  border: 1px solid rgba(94, 234, 212, 0.15);
  color: #cbd5e1;
  border-radius: 10px;
  padding: 8px 10px;
  font: 13px system-ui;
  cursor: pointer;
}
.row {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.primary,
.ghost {
  border: 0;
  border-radius: 999px;
  padding: 11px 20px;
  font: 700 15px system-ui;
  cursor: pointer;
}
.primary {
  background: #5eead4;
  color: #042f2e;
}
.primary:disabled {
  opacity: 0.5;
}
.ghost {
  background: transparent;
  color: #94a3b8;
}
</style>
