<template>
  <header class="topbar" data-tauri-drag-region>
    <span class="topbar__brand" data-tauri-drag-region>🦴 Osteosome</span>
    <span class="topbar__spacer" data-tauri-drag-region></span>
    <span class="topbar__badge" :class="{ 'topbar__badge--ok': allReady }" data-tauri-drag-region>
      <span class="topbar__dot" :class="allReady ? 'ok' : 'warn'"></span>
      {{ services.readyCount }}/{{ services.totalCount }} 服务
    </span>
    <template v-if="layout.mode === 'edit'">
      <Button size="sm" variant="ghost" @click="layout.newPanel">新建面板</Button>
    </template>
    <button
      class="topbar__mode"
      :class="{ 'topbar__mode--on': layout.mode === 'edit' }"
      type="button"
      @click="toggleMode"
    >
      {{ layout.mode === 'edit' ? '✓ 编辑' : '✏️ 编辑' }}
    </button>
    <button class="topbar__mode" type="button" @click="openPlugins">🧩 插件</button>
    <WindowControls />
  </header>
</template>

<script setup lang="ts">
import { useLayoutStore } from '../layout/layout.store'
import { useServiceStatus } from '../core-sdk/useServiceStatus'
import { openPluginWindow } from '../layout/window-manager'
import Button from '../components/ui/Button.vue'
import WindowControls from '../components/layout/WindowControls.vue'

const layout = useLayoutStore()
const services = useServiceStatus()

const allReady = services.readyCount === services.totalCount && services.totalCount > 0

function toggleMode(): void { layout.setMode(layout.mode === 'edit' ? 'runtime' : 'edit') }

function openPlugins(): void {
  // 插件管理：独立原生窗（对齐 demo D1 列表）。点击「插件」弹出，不再进编辑模式自动弹。
  openPluginWindow()
}
</script>

<style scoped>
.topbar {
  flex-shrink: 0;
  height: 44px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 0 0 var(--space-4);
  background: linear-gradient(180deg, var(--color-topbar-bg) 0%, var(--color-topbar-bg-2) 100%);
  border-bottom: 1px solid var(--color-topbar-border);
  box-shadow: var(--shadow-sm);
  color: var(--color-topbar-text);
}
.topbar__brand {
  font-weight: 700;
  margin-right: var(--space-2);
  color: var(--color-topbar-text);
  letter-spacing: 0.02em;
}
.topbar__spacer { flex: 1; }
.topbar__badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-xs);
  padding: 1px 8px;
  border-radius: var(--radius-full);
  background: var(--color-topbar-overlay);
  color: var(--color-topbar-text);
}
.topbar__dot { width: 7px; height: 7px; border-radius: 50%; }
.topbar__dot.ok { background: #4ade80; box-shadow: 0 0 0 2px rgba(74, 222, 128, 0.25); }
.topbar__dot.warn { background: #fbbf24; box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.25); }
.topbar__mode {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-sm);
  padding: 5px 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-topbar-overlay-strong);
  background: var(--color-topbar-overlay);
  color: var(--color-topbar-text);
  cursor: pointer;
  font-family: inherit;
}
.topbar__mode:hover { background: var(--color-topbar-overlay-strong); }
.topbar__mode:focus-visible { outline: 2px solid var(--color-topbar-text); outline-offset: 2px; }
.topbar__mode--on {
  background: var(--color-topbar-text);
  border-color: var(--color-topbar-text);
  color: var(--color-topbar-bg);
  font-weight: 600;
}
.topbar :deep(.ui-button--ghost) {
  background: var(--color-topbar-overlay);
  border-color: var(--color-topbar-overlay-strong);
  color: var(--color-topbar-text);
}
.topbar :deep(.ui-button--ghost:hover:not(:disabled)) {
  background: var(--color-topbar-overlay-strong);
}
</style>
