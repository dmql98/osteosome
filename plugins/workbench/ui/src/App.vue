<script setup lang="ts">
/**
 * 插件 UI 的根组件：**按 hash 决定渲染哪个视图**（P6）。
 *
 * ## 六个视图 = 一个 bundle + 一个 index.html
 *
 * `plugin.json` 里声明了六个 `ui.views`，entry 都是 `index.html#<view>`。
 * 也就是说 Core 伺服的是**同一个**页面，宿主给每个盒子一个带不同 hash 的 `src` ——
 * 于是六个组件共用一份 bundle、一份 vue 副本。
 *
 * 这个取舍的代价写在 §6 的风险台账里（bundle 重复），收益是：装一个插件只多一份
 * 产物，而不是六份。
 *
 * ## hash 而非路径
 *
 * `index.html#system-info` 的 `#` 之后**根本不会发到服务器**，所以 Core 只当静态文件
 * 搬运工：没有路由表、没有重写规则。深链与刷新能不能工作，全由这份 hash 状态决定。
 *
 * ## 与宿主的一致性：主题与语言
 *
 * 两者都存在宿主的偏好里，而 iframe 与宿主同源 → 直接读。
 * CSS 变量（tokens.css）随 `data-theme` 切换，于是插件界面和工作台看起来是一套东西。
 */
import { computed, onMounted, ref } from 'vue'
import { usePreferences } from '@osteosome/core-client'
import { initLocale } from './i18n'
import CommandPaletteWidget from './views/CommandPaletteWidget.vue'
import EventStreamWidget from './views/EventStreamWidget.vue'
import ServiceManagerWidget from './views/ServiceManagerWidget.vue'
import ServiceStatusWidget from './views/ServiceStatusWidget.vue'
import SettingsPaneView from './views/SettingsPaneView.vue'
import SystemInfoWidget from './views/SystemInfoWidget.vue'

/** view id（= widget id 的最后一段）→ 组件 */
const VIEWS = {
  'system-info': SystemInfoWidget,
  'command-palette': CommandPaletteWidget,
  settings: SettingsPaneView,
  'event-stream': EventStreamWidget,
  'service-manager': ServiceManagerWidget,
  'service-status': ServiceStatusWidget,
} as const

type ViewId = keyof typeof VIEWS

/** 与 plugin.json 的 ui.views 一一对应；**改一处必须改另一处**，下面有断言守着 */
const VIEW_IDS: ViewId[] = [
  'system-info',
  'command-palette',
  'settings',
  'event-stream',
  'service-manager',
  'service-status',
]

function viewFromHash(hash: string): ViewId | null {
  const id = hash.replace(/^#/, '') as ViewId
  return id in VIEWS ? id : null
}

const view = ref<ViewId | null>(viewFromHash(window.location.hash))

function onHashChange(): void {
  view.value = viewFromHash(window.location.hash)
}

onMounted(async () => {
  const preferences = usePreferences()
  try {
    const prefs = await preferences.get()
    const theme = (prefs as { ui?: { theme?: unknown } }).ui?.theme
    if (theme === 'dark' || theme === 'light') {
      document.documentElement.setAttribute('data-theme', theme)
    }
  } catch {
    // 未连接：保持默认主题
  }
  await initLocale(() => preferences.get() as Promise<Record<string, unknown>>)
  window.addEventListener('hashchange', onHashChange)
})

const current = computed(() => (view.value ? VIEWS[view.value] : null))

/** 未知 hash 时给的那句话。模板里不能直接写 `window` —— 那是模块作用域的东西 */
const hashLabel = computed(() => window.location.hash || '(空)')
const viewNames = Object.keys(VIEWS).join(' · ')

/**
 * 开发期自检：映射表与声明的视图 id 对不上时提个醒。
 *
 * 这里刻意**不用 `import.meta.env.DEV`** 做条件 —— vite 的 env 类型要额外引入
 * `vite/client`，而它现在只在 `types` 里声明过、运行时未必可用。改成「无条件检查、
 * 静默无操作」更简单：多一次 `Object.keys().length` 在生产里毫无影响。
 */
if (Object.keys(VIEWS).length !== VIEW_IDS.length) {
  console.warn('[workbench-ui] VIEWS 与 VIEW_IDS 数量不一致')
}
</script>

<template>
  <div class="plugin-root">
    <component :is="current" v-if="current" />
    <p v-else class="plugin-root__unknown">
      未知视图（<code>{{ hashLabel }}</code>）。
      本插件提供：{{ viewNames }}
    </p>
  </div>
</template>

<style scoped>
/* 铺满宿主给的盒子：插件页面不该在 iframe 里再留一圈白边 */
.plugin-root {
  height: 100%;
  min-height: 0;
  overflow: auto;
  background: var(--color-surface);
  color: var(--color-text);
}
.plugin-root__unknown {
  margin: var(--space-4);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}
</style>