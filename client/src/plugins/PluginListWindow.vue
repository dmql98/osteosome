<template>
  <div class="plugin-win">
    <header class="plugin-win__bar" data-tauri-drag-region>
      <span class="plugin-win__title" data-tauri-drag-region>🧩 插件管理</span>
      <input v-model="query" class="plugin-win__search" placeholder="搜索插件…" />
      <span class="plugin-win__spacer" data-tauri-drag-region></span>
      <Button size="sm" variant="ghost" @click="refresh">刷新</Button>
      <WindowControls />
    </header>
    <div class="plugin-win__body">
      <EmptyState
        v-if="!plugins.length"
        icon="📦"
        title="还没有插件"
        description="内置插件未加载，或已被全部卸载。"
      />
      <div v-else class="plugin-win__list">
        <div class="plugin-win__section-title">已安装 ({{ plugins.length }})</div>
        <div v-for="plugin in filtered" :key="plugin.id" class="plugin-card">
          <div class="plugin-card__icon">{{ plugin.icon }}</div>
          <div class="plugin-card__info">
            <div class="plugin-card__name">
              {{ plugin.name }}
              <span class="plugin-card__badge">v{{ plugin.version }}</span>
            </div>
            <div class="plugin-card__meta">{{ plugin.widgets.length }} 组件 · 依赖: {{ dependencyText(plugin) }}</div>
            <div class="plugin-card__status">
              <span class="dot" :class="store.isEnabled(plugin.id) ? 'green' : 'gray'"></span>
              {{ store.isEnabled(plugin.id) ? '运行中' : '已停用' }}
            </div>
          </div>
          <div class="plugin-card__actions">
            <button
              type="button"
              class="plugin-toggle"
              :class="store.isEnabled(plugin.id) ? 'plugin-toggle--disable' : 'plugin-toggle--enable'"
              @click="toggle(plugin.id)"
            >
              {{ store.isEnabled(plugin.id) ? '禁用' : '启用' }}
            </button>
            <Button size="sm" variant="ghost" @click="manage(plugin.id)">管理</Button>
          </div>
        </div>
        <p v-if="!filtered.length" class="plugin-win__empty">没有匹配的插件</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import Button from '@/components/ui/Button.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import WindowControls from '@/components/layout/WindowControls.vue'
import { usePluginStore } from '@/stores/plugin.store'
import { openPluginDetailWindow } from '@/layout/window-manager'
import { notifyPluginsChanged } from '@/layout/window-events'
import type { PluginDefinition } from './registry'

const store = usePluginStore()
const query = ref('')

const plugins = computed(() => store.installed)
const filtered = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  if (!keyword) return plugins.value
  return plugins.value.filter(
    (plugin) => plugin.name.toLowerCase().includes(keyword) || plugin.id.toLowerCase().includes(keyword),
  )
})

function dependencyText(plugin: PluginDefinition): string {
  return plugin.dependencies.length ? plugin.dependencies.map((item) => item.label).join('、') : '无'
}

async function toggle(pluginId: string): Promise<void> {
  await store.toggle(pluginId)
  notifyPluginsChanged()
}

function manage(pluginId: string): void {
  openPluginDetailWindow(pluginId)
}

function refresh(): void {
  void store.bootstrap()
}

onMounted(() => {
  if (!store.hydrated) void store.bootstrap()
})
</script>

<style scoped>
.plugin-win { display: flex; flex-direction: column; height: 100%; background: var(--color-surface); }
.plugin-win__bar { display: flex; align-items: center; gap: var(--space-2); height: 40px; padding: 0 0 0 var(--space-3); border-bottom: 1px solid var(--color-border); flex: none; }
.plugin-win__title { font-weight: 700; font-size: var(--text-md); }
.plugin-win__search { flex: 1; max-width: 240px; padding: 5px 10px; border: 1px solid var(--color-border); border-radius: var(--radius-md); font-family: inherit; font-size: var(--text-sm); background: var(--color-surface); color: var(--color-text); }
.plugin-win__search:focus { outline: 2px solid var(--color-focus-ring); outline-offset: 1px; border-color: transparent; }
.plugin-win__spacer { flex: 1; }
.plugin-win__body { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-4); }
.plugin-win__list { display: flex; flex-direction: column; gap: var(--space-3); }
.plugin-win__section-title { font-size: var(--text-sm); font-weight: 700; color: var(--color-text-muted); }
.plugin-win__empty { margin: 0; font-size: var(--text-sm); color: var(--color-text-muted); text-align: center; padding: var(--space-4); }
.plugin-card { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); }
.plugin-card:hover { border-color: var(--color-primary); }
.plugin-card__icon { width: 40px; height: 40px; border-radius: var(--radius-md); background: var(--color-surface-2); display: grid; place-items: center; font-size: 20px; flex: none; }
.plugin-card__info { flex: 1; min-width: 0; }
.plugin-card__name { font-weight: 600; font-size: var(--text-sm); display: flex; align-items: center; gap: 6px; }
.plugin-card__badge { font-size: var(--text-xs); color: var(--color-text-muted); border: 1px solid var(--color-border); border-radius: var(--radius-full); padding: 0 6px; }
.plugin-card__meta { font-size: var(--text-xs); color: var(--color-text-muted); margin-top: 2px; }
.plugin-card__status { display: flex; align-items: center; gap: 4px; font-size: var(--text-xs); color: var(--color-text-muted); margin-top: 2px; }
.plugin-card__actions { display: flex; gap: var(--space-2); flex: none; }
.plugin-toggle {
  height: 24px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-md);
  border: 1px solid currentColor;
  background: var(--color-surface);
  font-family: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
}
.plugin-toggle--enable { color: var(--color-primary); }
.plugin-toggle--enable:hover { background: var(--color-primary-soft); }
.plugin-toggle--disable { color: var(--color-danger); }
.plugin-toggle--disable:hover { background: var(--color-danger-soft); }
</style>
