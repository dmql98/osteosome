<template>
  <div v-if="visible" class="win-controls">
    <button class="win-controls__btn" type="button" title="最小化" aria-label="最小化" @click="minimize">
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 5h8" stroke="currentColor" stroke-width="1" /></svg>
    </button>
    <button class="win-controls__btn" type="button" :title="maximizeTitle" :aria-label="maximizeTitle" @click="toggleMaximize">
      <svg v-if="!maximized" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1" /></svg>
      <svg v-else width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="1.5" y="3" width="5.5" height="5.5" fill="none" stroke="currentColor" stroke-width="1" /><path d="M3.5 3V1.5h5v5H7" fill="none" stroke="currentColor" stroke-width="1" /></svg>
    </button>
    <button class="win-controls__btn win-controls__btn--close" type="button" title="关闭" aria-label="关闭" @click="close">
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1" /></svg>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauri } from '@/tauri/plugin-window'

// 无边框窗口（decorations:false）的自绘窗口控制：非 Tauri 环境不渲染（浏览器/测试）。
const visible = isTauri()
const maximized = ref(false)
const maximizeTitle = computed(() => (maximized.value ? '还原' : '最大化'))
let unlisten: (() => void) | null = null

onMounted(async () => {
  if (!visible) return
  const win = getCurrentWindow()
  maximized.value = await win.isMaximized()
  unlisten = await win.onResized(async () => { maximized.value = await getCurrentWindow().isMaximized() })
})
onBeforeUnmount(() => unlisten?.())

function minimize(): void { void getCurrentWindow().minimize() }
function toggleMaximize(): void { void getCurrentWindow().toggleMaximize() }
function close(): void { void getCurrentWindow().close() }
</script>

<style scoped>
.win-controls { display: inline-flex; align-items: stretch; height: 100%; }
.win-controls__btn { width: 40px; height: 100%; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: 0; background: transparent; cursor: pointer; }
.win-controls__btn:hover { background: color-mix(in srgb, currentColor 16%, transparent); }
.win-controls__btn--close:hover { background: var(--color-danger); color: #fff; }
</style>
