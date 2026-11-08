<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Company } from '../types'

const props = defineProps<{ company: Company; size?: number }>()
const failed = ref(false)
const initials = computed(() =>
  props.company.name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join(''),
)
const bg = computed(() => props.company.brand_color ?? '#334155')
</script>

<template>
  <img
    v-if="company.logo_url && !failed"
    :src="company.logo_url"
    :alt="company.name"
    class="logo"
    :style="{ width: (size ?? 44) + 'px', height: (size ?? 44) + 'px' }"
    @error="failed = true"
  />
  <div v-else class="logo initials" :style="{ background: bg, width: (size ?? 44) + 'px', height: (size ?? 44) + 'px', fontSize: (size ?? 44) * 0.38 + 'px' }">
    {{ initials }}
  </div>
</template>

<style scoped>
.logo {
  border-radius: 12px;
  flex: none;
  object-fit: contain;
  background: #fff;
}
.initials {
  display: grid;
  place-items: center;
  color: #fff;
  font-weight: 800;
  letter-spacing: -0.02em;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.15);
}
</style>
