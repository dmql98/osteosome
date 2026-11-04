<template>
  <div class="plugin-list">
    <div class="plugin-list__toolbar">
      <input v-model="query" class="plugin-list__search" placeholder="搜索插件…" />
      <span class="plugin-list__spacer"></span>
      <Button size="sm" variant="ghost" class="plugin-refresh" @click="refresh">刷新</Button>
    </div>
    <div class="plugin-list__body">
      <p v-if="actionError" class="plugin-list__error">{{ actionError }}</p>
      <EmptyState
        v-if="!plugins.length"
        icon="📦"
        :title="emptyTitle"
        :description="emptyDescription"
      />
      <div v-else class="plugin-list__items">
        <div class="plugin-list__section-title">已安装 ({{ plugins.length }})</div>
        <!--
          卡片本身就是入口：点击进入该插件的配置页（同一个窗口内切换，不再另开窗口）。
          因为里面还要放一个真正的 <button role="switch">，卡片用 div + role="button"
          而不是 <button> —— 按钮不能嵌套按钮，否则焦点与键盘行为都会坏掉。
        -->
        <div
          v-for="plugin in filtered"
          :key="plugin.id"
          class="plugin-card"
          role="button"
          tabindex="0"
          :aria-label="`配置 ${plugin.name}`"
          @click="open(plugin.id)"
          @keydown.enter.prevent="open(plugin.id)"
          @keydown.space.prevent="open(plugin.id)"
        >
          <div class="plugin-card__icon">{{ plugin.icon }}</div>
          <div class="plugin-card__info">
            <div class="plugin-card__name">
              {{ plugin.name }}
              <span class="plugin-card__badge">v{{ plugin.version }}</span>
            </div>
            <div class="plugin-card__meta">{{ widgetCount(plugin) }} 组件 · 依赖: {{ dependencyText(plugin) }}</div>
            <div class="plugin-card__status">
              <span class="dot" :class="statusDot(plugin)"></span>
              {{ statusText(plugin) }}
              <span v-if="plugin.state !== 'ready' && plugin.reason" class="plugin-card__reason">
                {{ plugin.reason }}
              </span>
            </div>
          </div>
          <!-- 开关是卡片内的独立控件：必须 stop，否则点开关会连带打开配置页 -->
          <div class="plugin-card__toggle" @click.stop @keydown.stop>
            <Switch
              :model-value="store.isEnabled(plugin.id)"
              :disabled="pendingId === plugin.id"
              :aria-label="`${store.isEnabled(plugin.id) ? '停用' : '启用'} ${plugin.name}`"
              @update:model-value="(value) => toggle(plugin.id, value)"
            />
          </div>
          <span class="plugin-card__chevron" aria-hidden="true">›</span>
        </div>
        <p v-if="!filtered.length" class="plugin-list__empty">没有匹配的插件</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Button } from '@osteosome/ui'
import { EmptyState } from '@osteosome/ui'
import { Switch } from '@osteosome/ui'
import { usePlugins } from '@/core-sdk/usePlugins'
import { notifyPluginsChanged } from '@/layout/window-events'
import { addableWidgetIds } from '@/widgets/registry'
import type { PluginView } from './registry'

const emit = defineEmits<{ open: [pluginId: string] }>()

const { store, reload } = usePlugins()
const query = ref('')
/** 启停失败提示。命令失败时状态不会变，所以不给提示就等于骗人 */
const actionError = ref('')
/** 正在等 Core 回应的插件 —— 期间禁用它的开关，避免连点发出两条相反的命令 */
const pendingId = ref('')

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
 * 卡片上的「N 组件」必须数 `ui.views ∪ components`，不能只数 `components`。
 *
 * P5/P6 之后所有插件的界面都由 `ui.views` 声明，`components[]` 恒为空 ——
 * 直接读它会让**每个插件都显示 0 组件**，而详情窗里明明列得出组件，
 * 两处说法打架，用户无从判断哪个是真的。判据与详情窗的列表同源（`addableWidgetIds`）。
 */
function widgetCount(plugin: PluginView): number {
  return addableWidgetIds(plugin).length
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

async function toggle(pluginId: string, enabled: boolean): Promise<void> {
  if (pendingId.value) return
  pendingId.value = pluginId
  try {
    const ok = await store.setEnabled(pluginId, enabled)
    // 停用失败必须说出来：否则开关弹回去，用户以为成功了，
    // 而进程其实还在跑 —— 这是最难受的一种骗（状态看起来是对的）
    actionError.value = ok
      ? ''
      : `「${store.byId(pluginId)?.name ?? pluginId}」${enabled ? '启用' : '停用'}失败，Core 未接受该命令`
    if (ok) notifyPluginsChanged()
  } finally {
    pendingId.value = ''
  }
}

/** 进入该插件的配置页。窗口由外层 `PluginManagerWindow` 复用，这里只上报意图 */
function open(pluginId: string): void {
  emit('open', pluginId)
}

function refresh(): void {
  void reload()
}
</script>

<style scoped>
.plugin-list { display: flex; flex-direction: column; flex: 1; min-height: 0; background: var(--color-surface); }
.plugin-list__toolbar { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-border); flex: none; }
.plugin-list__search { flex: 1; max-width: 240px; padding: 5px 10px; border: 1px solid var(--color-border); border-radius: var(--radius-md); font-family: inherit; font-size: var(--text-sm); background: var(--color-surface); color: var(--color-text); }
.plugin-list__search:focus { outline: 2px solid var(--color-focus-ring); outline-offset: 1px; border-color: transparent; }
.plugin-list__spacer { flex: 1; }
.plugin-list__error { margin: 0 0 var(--space-3); padding: var(--space-2) var(--space-3); border: 1px solid var(--color-danger); border-radius: var(--radius-md); background: var(--color-danger-soft); color: var(--color-danger); font-size: var(--text-xs); }
.plugin-list__body { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-4); }
.plugin-list__items { display: flex; flex-direction: column; gap: var(--space-3); }
.plugin-list__section-title { font-size: var(--text-sm); font-weight: 700; color: var(--color-text-muted); }
.plugin-list__empty { margin: 0; font-size: var(--text-sm); color: var(--color-text-muted); text-align: center; padding: var(--space-4); }
.plugin-card { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); cursor: pointer; }
.plugin-card:hover { border-color: var(--color-primary); }
.plugin-card:focus-visible { outline: 2px solid var(--color-focus-ring); outline-offset: 1px; }
.plugin-card__icon { width: 40px; height: 40px; border-radius: var(--radius-md); background: var(--color-surface-2); display: grid; place-items: center; font-size: 20px; flex: none; }
.plugin-card__info { flex: 1; min-width: 0; }
.plugin-card__name { font-weight: 600; font-size: var(--text-sm); display: flex; align-items: center; gap: 6px; }
.plugin-card__badge { font-size: var(--text-xs); color: var(--color-text-muted); border: 1px solid var(--color-border); border-radius: var(--radius-full); padding: 0 6px; }
.plugin-card__meta { font-size: var(--text-xs); color: var(--color-text-muted); margin-top: 2px; }
.plugin-card__status { display: flex; align-items: center; gap: 4px; font-size: var(--text-xs); color: var(--color-text-muted); margin-top: 2px; }
/* 开关区：固定宽度右对齐，点它不触发卡片跳转（见模板上的 @click.stop） */
.plugin-card__toggle { flex: none; display: flex; align-items: center; }
.plugin-card__chevron { flex: none; font-size: var(--text-md); color: var(--color-text-muted); line-height: 1; }
</style>
