<template>
  <header v-if="layout.mode === 'edit'" class="top-bar">
    <span class="top-bar__brand">Osteosome</span>
    <div class="top-bar__status">
      <span class="top-bar__placeholder">{{ layout.mode === 'edit' ? '编辑模式' : '运行模式' }}</span>
      <span class="top-bar__status-count">服务 {{ services.readyCount }}/{{ services.totalCount }}</span>
    </div>
    <div class="top-bar__actions">
      <Button size="sm" variant="ghost" @click="layout.newPanel">新建面板</Button>
      <Dropdown :items="widgetItems" @select="layout.addWidget">
        <template #trigger>添加组件</template>
      </Dropdown>
      <button class="top-bar__mode" type="button" @click="toggleMode">{{ layout.mode === 'edit' ? '进入运行' : '返回编辑' }}</button>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useLayoutStore } from '../layout/layout.store'
import { useServiceStatus } from '../core-sdk/useServiceStatus'
import Dropdown from '../components/ui/Dropdown.vue'
import Button from '../components/ui/Button.vue'
import { listWidgets } from '../widgets/registry'
const layout = useLayoutStore()
const services = useServiceStatus()
const widgetItems = computed(() => listWidgets().map((widget) => ({ label: widget.title, value: widget.id })))
function toggleMode(): void { layout.setMode(layout.mode === 'edit' ? 'runtime' : 'edit') }
</script>

<style scoped>
.top-bar {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  height: 44px;
  padding: 0 var(--space-4);
  background-color: var(--color-surface);
  border-bottom: 1px solid var(--color-border);
  box-shadow: var(--shadow-sm);
}

.top-bar__brand {
  font-size: var(--text-md);
  font-weight: 600;
}

.top-bar__status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
}

.top-bar__placeholder {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.top-bar__status-count {
  padding: 2px 6px;
  border-radius: var(--radius-full);
  background: var(--color-surface-2);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}

.top-bar__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.top-bar__mode {
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text);
  cursor: pointer;
  font-size: var(--text-sm);
}

.top-bar__mode:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}
</style>
