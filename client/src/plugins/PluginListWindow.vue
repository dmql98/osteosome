<template>
  <div class="plugin-win">
    <header class="plugin-win__bar" data-tauri-drag-region>
      <span class="plugin-win__title" data-tauri-drag-region>🧩 插件管理</span>
      <input v-model="query" class="plugin-win__search" placeholder="搜索插件…" />
      <span class="plugin-win__spacer" data-tauri-drag-region></span>
      <Button size="sm" variant="ghost" class="plugin-refresh" @click="refresh">刷新</Button>
      <WindowControls />
    </header>
    <div class="plugin-win__body">
      <p v-if="actionError" class="plugin-win__error">{{ actionError }}</p>
      <EmptyState
        v-if="!plugins.length"
        icon="📦"
        :title="emptyTitle"
        :description="emptyDescription"
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
            <div class="plugin-card__meta">{{ plugin.components.length }} 组件 · 依赖: {{ dependencyText(plugin) }}</div>
            <div class="plugin-card__status">
              <span class="dot" :class="statusDot(plugin)"></span>
              {{ statusText(plugin) }}
              <span v-if="plugin.state !== 'ready' && plugin.reason" class="plugin-card__reason">
                {{ plugin.reason }}
              </span>
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
import { computed, ref } from 'vue'
import Button from '@/components/ui/Button.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import WindowControls from '@/components/layout/WindowControls.vue'
import { usePlugins } from '@/core-sdk/usePlugins'
import { openPluginDetailWindow } from '@/layout/window-manager'
import { notifyPluginsChanged } from '@/layout/window-events'
import type { PluginView } from './registry'

const { store, reload } = usePlugins()
const query = ref('')
/** 启停失败提示。命令失败时状态不会变，所以不给提示就等于骗人 */
const actionError = ref('')

const plugins = computed(() => store.installed)
const filtered = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  if (!keyword) return plugins.value
  return plugins.value.filter(
    (plugin) => plugin.name.toLowerCase().includes(keyword) || plugin.id.toLowerCase().includes(keyword),
  )
})

function dependencyText(plugin: PluginView): string {
  return plugin.dependencies.length ? plugin.dependencies.map((item) => item.label).join('、') : '无'
}

/**
 * 空态要区分三件事，不能一律写「还没有插件」。
 *
 * S7-3 之前这句话是写死的，于是「插件层没启用」「插件层坏了」「真的一个都没装」
 * 在界面上完全一样 —— 用户只会得出「没插件」，于是以为一切正常。
 * `layer` 就是为了让这三种可分辨；不用它等于白做这个字段。
 */
const emptyTitle = computed(() => {
  if (store.layer === 'disabled') return '插件层未启用'
  if (store.layer === 'missing-dir') return '插件目录不存在'
  if (store.layer === 'empty') return '插件目录里没有清单'
  return '还没有插件'
})

const emptyDescription = computed(() => {
  if (store.layer === 'disabled') return '当前以 --plugins none 启动，插件层已关闭（测试与显式意图）。'
  if (store.layer === 'missing-dir') return `找不到 ${store.pluginsDir ?? '插件目录'}，已退回全启启动服务。`
  if (store.layer === 'empty') return '目录存在但没有任何 plugin.json —— 是不是漏了插件清单？'
  return '内置插件未加载，或已被全部卸载。'
})

/**
 * 状态行有**两个独立的轴**，别混成一个：
 * · 用户意愿（启用 / 停用）—— 本地 prefs，Core 并不知道
 * · 实际状态（ready / degraded / failed）—— Core 派生
 *
 * 只显示前者的话，一个 degraded 的插件会显示「运行中」——
 * 用户看到绿灯却发不出请求，而界面上没有任何线索说它坏了。
 */
function statusText(plugin: PluginView): string {
  if (!store.isEnabled(plugin.id)) return '已停用'
  if (plugin.state === 'degraded') return '降级'
  if (plugin.state === 'failed') return '故障'
  if (plugin.state === 'stopped') return '未运行'
  return '运行中'
}

function statusDot(plugin: PluginView): string {
  if (!store.isEnabled(plugin.id)) return 'gray'
  if (plugin.state === 'failed') return 'red'
  if (plugin.state === 'degraded') return 'yellow'
  if (plugin.state === 'stopped') return 'gray'
  return 'green'
}

async function toggle(pluginId: string): Promise<void> {
  const ok = await store.toggle(pluginId)
  // 停用失败必须说出来：否则卡片回到「运行中」，用户以为成功了，
  // 而进程其实还在跑 —— 这是最难受的一种骗（状态看起来是对的）
  actionError.value = ok ? '' : `「${store.byId(pluginId)?.name ?? pluginId}」停用失败，Core 未接受该命令`
  if (ok) notifyPluginsChanged()
}

function manage(pluginId: string): void {
  openPluginDetailWindow(pluginId)
}

function refresh(): void {
  void reload()
}
</script>

<style scoped>
.plugin-win { display: flex; flex-direction: column; height: 100%; background: var(--color-surface); }
.plugin-win__bar { display: flex; align-items: center; gap: var(--space-2); height: 40px; padding: 0 0 0 var(--space-3); border-bottom: 1px solid var(--color-border); flex: none; }
.plugin-win__title { font-weight: 700; font-size: var(--text-md); }
.plugin-win__search { flex: 1; max-width: 240px; padding: 5px 10px; border: 1px solid var(--color-border); border-radius: var(--radius-md); font-family: inherit; font-size: var(--text-sm); background: var(--color-surface); color: var(--color-text); }
.plugin-win__search:focus { outline: 2px solid var(--color-focus-ring); outline-offset: 1px; border-color: transparent; }
.plugin-win__spacer { flex: 1; }
.plugin-win__error { margin: 0 0 var(--space-3); padding: var(--space-2) var(--space-3); border: 1px solid var(--color-danger); border-radius: var(--radius-md); background: var(--color-danger-soft); color: var(--color-danger); font-size: var(--text-xs); }
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
