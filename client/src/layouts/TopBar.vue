<template>
  <header class="topbar">
    <span class="topbar__brand">🦴 Osteosome</span>
    <span class="topbar__spacer"></span>
    <span class="topbar__badge" :class="{ 'topbar__badge--ok': allReady }">
      <span class="topbar__dot" :class="allReady ? 'ok' : 'warn'"></span>
      {{ services.readyCount }}/{{ services.totalCount }} 服务
    </span>
    <template v-if="layout.mode === 'edit'">
      <Button size="sm" variant="ghost" @click="layout.newPanel">新建面板</Button>
      <Dropdown :items="widgetItems" @select="layout.addWidget">
        <template #trigger>添加组件</template>
      </Dropdown>
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
  </header>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useLayoutStore } from '../layout/layout.store'
import { useServiceStatus } from '../core-sdk/useServiceStatus'
import { listWidgets } from '../widgets/registry'
import Button from '../components/ui/Button.vue'
import Dropdown from '../components/ui/Dropdown.vue'

const layout = useLayoutStore()
const services = useServiceStatus()

const widgetItems = computed(() => listWidgets().map((widget) => ({ label: widget.title, value: widget.id })))
const allReady = services.readyCount === services.totalCount && services.totalCount > 0

function toggleMode(): void { layout.setMode(layout.mode === 'edit' ? 'runtime' : 'edit') }

function openPlugins(): void {
  // 插件管理：独立原生窗口。P1 阶段先用「服务管理」组件占位，
  // Tauri 多窗口接好后换成真正的插件管理窗。
  layout.addWidget('widget.service-manager')
}
</script>

<style scoped>
.topbar {
  flex-shrink: 0;
  height: 44px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-4);
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-border);
  box-shadow: var(--shadow-sm);
}
.topbar__brand { font-weight: 700; margin-right: var(--space-2); }
.topbar__spacer { flex: 1; }
.topbar__badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-xs);
  padding: 1px 8px;
  border-radius: var(--radius-full);
  background: var(--color-surface-2);
  color: var(--color-text-muted);
}
.topbar__dot { width: 7px; height: 7px; border-radius: 50%; }
.topbar__dot.ok { background: var(--color-success); }
.topbar__dot.warn { background: var(--color-warning); }
.topbar__mode {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-sm);
  padding: 5px 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text);
  cursor: pointer;
  font-family: inherit;
}
.topbar__mode:hover { background: var(--color-surface-2); }
.topbar__mode:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
.topbar__mode--on {
  background: var(--color-primary-soft);
  border-color: var(--color-primary);
  color: var(--color-primary);
  font-weight: 600;
}
</style>
