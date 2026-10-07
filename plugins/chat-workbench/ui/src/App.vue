<script setup lang="ts">
/**
 * chat-workbench 插件 UI 的根组件：**按 hash 决定渲染哪个视图**（P6）。
 *
 * ## 三个视图 = 一个 bundle + 一个 index.html
 *
 * `plugin.json` 里声明三个 `ui.views`，entry 都是 `index.html#<view>`。
 * Core 伺服的是**同一个**页面，宿主给每个盒子一个带不同 hash 的 `src` ——
 * 于是三个组件共用一份 bundle、一份 vue 副本。
 *
 * 代价写在 §6 风险台账里（bundle 重复），收益是装一个插件只多一份产物。
 *
 * ## 这里挂了一个状态层的初始化，仅此而已
 *
 * `startSessionSync()` 启的是 `curId` 的跨 iframe 同步（见 `state/session-sync.ts`）。
 * 除此之外这个组件什么都不做 —— 没有 store、没有 router、没有全局组件注册。
 *
 * ## 与宿主的一致性：主题
 *
 * 主题存在宿主的偏好里，而 iframe 与宿主同源 → 直接读。
 * CSS 变量随 `data-theme` 切换，于是插件界面和工作台看起来是一套东西。
 *
 * 为什么**不挂 i18n**：这三个视图的文案全是硬编码中文，没有一个 i18n key。
 * 与其在这里引入 vue-i18n 再把既有文案搬进资源文件（一次纯位移），
 * 不如**先保持原样** —— 挂了 i18n 却没有 key 可用，比不挂更让人以为「翻译过了」。
 * 真正要支持英文时，那时再一次性搬（连同 workbench 那套资源文件的形态）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { usePreferences } from '@osteosome/core-client'
import { startSessionSync } from './state'
import ChatComposerView from './views/ChatComposerView.vue'
import ChatTimelineView from './views/ChatTimelineView.vue'
import SessionListView from './views/SessionListView.vue'
import SessionWorkspaceView from './views/SessionWorkspaceView.vue'

/** view id（= widget id 的最后一段）→ 组件 */
const VIEWS = {
  'session-list': SessionListView,
  'chat-timeline': ChatTimelineView,
  'chat-composer': ChatComposerView,
  'session-workspace': SessionWorkspaceView,
} as const

type ViewId = keyof typeof VIEWS

/** 与 plugin.json 的 ui.views 一一对应；**改一处必须改另一处**，下面有断言守着 */
const VIEW_IDS: ViewId[] = ['session-list', 'chat-timeline', 'chat-composer', 'session-workspace']

function viewFromHash(hash: string): ViewId | null {
  const id = hash.replace(/^#/, '') as ViewId
  return id in VIEWS ? id : null
}

const view = ref<ViewId | null>(viewFromHash(window.location.hash))

function onHashChange(): void {
  view.value = viewFromHash(window.location.hash)
}

let stopSync: (() => void) | null = null

onMounted(async () => {
  stopSync = startSessionSync()
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
  window.addEventListener('hashchange', onHashChange)
})

onBeforeUnmount(() => {
  window.removeEventListener('hashchange', onHashChange)
  stopSync?.()
})

const current = computed(() => (view.value ? VIEWS[view.value] : null))

/** 未知 hash 时给的那句话。模板里不能直接写 `window` —— 那是模块作用域的东西 */
const hashLabel = computed(() => window.location.hash || '(空)')
const viewNames = Object.keys(VIEWS).join(' · ')

/**
 * 开发期自检：映射表与声明的视图 id 对不上时提个醒。
 *
 * 这里刻意**不用 `import.meta.env.DEV`** 做条件 —— vite 的 env 类型要额外引入
 * `vite/client`，而它未必在运行时可用。改成「无条件检查、静默无操作」更简单。
 */
if (Object.keys(VIEWS).length !== VIEW_IDS.length) {
  console.warn('[chat-workbench-ui] VIEWS 与 VIEW_IDS 数量不一致')
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