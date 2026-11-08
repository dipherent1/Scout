<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useScout } from './stores/scout'
import BottomSheet from './ui/BottomSheet.vue'
import ContactsPanel from './ui/ContactsPanel.vue'
import Onboarding from './ui/Onboarding.vue'
import ScanView from './ui/ScanView.vue'
import SearchBar from './ui/SearchBar.vue'
import TuningPanel from './ui/TuningPanel.vue'

const store = useScout()
const search = ref<InstanceType<typeof SearchBar>>()
const panel = ref<'none' | 'tuning' | 'contacts'>('none')

onMounted(() => {
  void store.init()
})
</script>

<template>
  <main class="app">
    <ScanView @search="(q) => search?.prefill(q)" />

    <div class="topbar" @pointerdown.stop @pointerup.stop>
      <SearchBar ref="search" />
      <button class="icon" title="Who to contact" @click="panel = 'contacts'">
        <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm2 4v2h10V8H7Zm0 4v2h10v-2H7Zm0 4v2h6v-2H7Z"/></svg>
        <span v-if="store.contactList.length" class="badge">{{ store.contactList.length }}</span>
      </button>
      <button class="icon" title="Tuning" @click="panel = 'tuning'">
        <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M4 6h10.2a3 3 0 0 1 5.6 0H20v2h-.2a3 3 0 0 1-5.6 0H4V6Zm13 1a1 1 0 1 0 0 0Zm-13 9h2.2a3 3 0 0 1 5.6 0H20v2h-8.2a3 3 0 0 1-5.6 0H4v-2Z"/></svg>
      </button>
    </div>

    <BottomSheet />
    <TuningPanel v-if="panel === 'tuning'" @close="panel = 'none'" />
    <ContactsPanel v-if="panel === 'contacts'" @close="panel = 'none'" />
    <Onboarding v-if="store.onboardingOpen" />
  </main>
</template>

<style scoped>
.app {
  position: fixed;
  inset: 0;
  overflow: hidden;
}
.topbar {
  position: absolute;
  top: calc(env(safe-area-inset-top) + 10px);
  left: 10px;
  right: 10px;
  display: flex;
  gap: 8px;
  z-index: 30;
}
.icon {
  position: relative;
  width: 42px;
  height: 42px;
  flex: none;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(17, 20, 26, 0.72);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  color: #f9fafb;
  display: grid;
  place-items: center;
  cursor: pointer;
}
.badge {
  position: absolute;
  top: -3px;
  right: -3px;
  min-width: 18px;
  height: 18px;
  border-radius: 9px;
  background: #5eead4;
  color: #042f2e;
  font: 700 11px/18px system-ui;
  text-align: center;
}
</style>
