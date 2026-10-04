<template>
  <div class="plugin-host">
    <!--
      三种状态各自有话要说，别合并成一个 spinner：
      loading = 正在取产物；failed = 取不到（多半是没构建 / 停用 / 版本不合）；
      ready = 插件页面已经在接管自己的区域。
    -->
    <div v-if="state !== 'ready'" class="plugin-host__overlay" :class="`plugin-host__overlay--${state}`">
      <template v-if="state === 'loading'">
        <span class="plugin-host__spinner" aria-hidden="true" />
        <p class="plugin-host__text">正在载入 {{ title }}…</p>
      </template>
      <template v-else>
        <p class="plugin-host__title">{{ title }} 载入失败</p>
        <p class="plugin-host__text">{{ failedReason }}</p>
        <p class="plugin-host__src">{{ src }}</p>
        <p class="plugin-host__hint">
          这个页面由 Core 伺服插件产物（<code>plugins/&lt;插件&gt;/dist/ui/</code>）。
          404 通常意味着：插件没构建、已停用，或它声明的 Core 版本范围不满足当前 Core。
        </p>
      </template>
    </div>
    <iframe
      v-show="state === 'ready'"
      ref="frame"
      class="plugin-host__frame"
      :src="src"
      :title="title"
      sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
      referrerpolicy="no-referrer"
      @load="onLoad"
      @error="onError"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * 插件 WebUI 的宿主（P4）—— 一个 iframe，别无他物。
 *
 * ## 为什么是 iframe，而不是动态 import 它的 JS
 *
 * · **地址栏与「这个页面是什么」要能独立**。插件页面有自己的路由与标题；
 *   塞进主窗后，用户没法链接到它，也没法在自己的浏览器里打开调试。
 * · **故障被关在一个盒子里**。插件产物白屏时，主窗的顶栏、面板、命令台都还活着 ——
 *   而共享一个 Vue 运行时的话，一次 chunk 404 能让整窗一起崩。
 * · **升级不必重启整窗**。`<iframe :src>` 绑的是 Core 那个 URL，
 *   插件重新 build 之后刷新页面就是新的，不必动 client 的 bundle。
 *
 * ## 代价，以及为什么这次接受
 *
 * · store 不再是单例 → 插件 UI 与主窗用 `postMessage` / `BroadcastChannel` 通信（P5 定协议）
 * · CSS 与文案各自打包 → 同源下插件可以直接读 `/api/preferences` 的主题
 * · 多一层 DOM、焦点与键盘事件要跨边界（插件页面内自己处理）
 *
 * 这些都是「各插件 UI 相互独立」的正常代价，不是缺陷。
 * 选它是因为反过来的方案（共享运行时）会让「插件可以被单独替换/停用」这件事不成立。
 *
 * ## sandbox 的取舍
 *
 * 给了 `allow-same-origin`：它与宿主**同源**，插件 UI 才能用同源的那套通信与存储
 * （P5 的契约依赖它）。代价是「同源 iframe 能拿到宿主的 DOM」——
 * 但这与整个 client 本来就在同源下拥有完全权限相比，**没有新增权限**，
 * 所以这里不做隔离表演，只是把话说清楚。
 * 没给 `allow-top-navigation`：插件页面不该能改宿主的地址栏。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{ src: string; title: string }>()

type HostState = 'loading' | 'ready' | 'failed'
const state = ref<HostState>('loading')
const timedOut = ref(false)
const loadFailed = ref(false)
const frame = ref<HTMLIFrameElement | null>(null)

/**
 * 超时上限（毫秒）。
 *
 * 为什么要它：**iframe 的 `error` 事件对 HTTP 错误不触发**。
 * Core 回 404 时浏览器照样把那个「404 页面」当成功加载完，`load` 正常触发 ——
 * 于是 `<iframe @error>` 这条看起来很自然的写法**永远不会执行**，
 * 表现是「一块空白的框，什么都不说」。
 * 所以判定成功只能靠时间上限（或插件主动 handshake，见下）。
 */
const LOAD_TIMEOUT_MS = 8000

/** 插件主动说「我准备好了」的消息类型（P5 约定的握手；在此之前靠超时兜底） */
const READY_MESSAGE = 'osteosome:plugin-ui:ready'

let timer: ReturnType<typeof setTimeout> | undefined

function finish(next: HostState): void {
  state.value = next
  if (timer) clearTimeout(timer)
  timer = undefined
}

function onLoad(): void {
  // 404 也会走到这里，所以先看有没有在超时内真的握手过；
  // 没有握手但极快 load（本地资源）就按 ready 处理，避免「正常插件被误判失败」。
  if (timedOut.value || loadFailed.value) {
    finish('failed')
    return
  }
  finish('ready')
}

function onError(): void {
  loadFailed.value = true
  finish('failed')
}

/**
 * 等插件页握手。它会说「我渲染好了」，那才是真的好了 ——
 * `load` 只说明 HTML 到手，插件自己的 chunk 404 时它是**不会**出错的。
 */
function onMessage(event: MessageEvent): void {
  if (event.origin !== window.location.origin) return
  if ((event.data as { type?: string } | null)?.type !== READY_MESSAGE) return
  if ((event.data as { src?: string }).src !== props.src) return
  finish('ready')
}

const failedReason = computed(() => {
  if (loadFailed.value) return '浏览器没能加载这个地址。'
  if (timedOut.value) return '超时：插件页面没有在预期时间内就绪。'
  return 'Core 没能伺服这个插件页面。'
})

onMounted(() => {
  window.addEventListener('message', onMessage)
  timer = setTimeout(() => {
    timedOut.value = true
    // 握手已经到了（onMessage 先跑完）就别翻脸：超时不代表失败
    if (state.value !== 'ready') finish('failed')
  }, LOAD_TIMEOUT_MS)
})

onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage)
  if (timer) clearTimeout(timer)
})
</script>

<style scoped>
.plugin-host { position: relative; width: 100%; height: 100%; min-height: 0; }
.plugin-host__frame { width: 100%; height: 100%; border: 0; display: block; background: var(--color-surface); }
.plugin-host__overlay { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--space-2); padding: var(--space-4); text-align: center; color: var(--color-text-muted); }
.plugin-host__overlay--failed { background: var(--color-surface); }
.plugin-host__title { margin: 0; font-size: var(--text-sm); font-weight: 600; color: var(--color-text); }
.plugin-host__text { margin: 0; font-size: var(--text-xs); }
.plugin-host__src { margin: 0; font-size: var(--text-xs); font-family: var(--font-mono, monospace); color: var(--color-text-subtle, var(--color-text-muted)); word-break: break-all; }
.plugin-host__hint { margin: var(--space-2) 0 0; font-size: var(--text-xs); line-height: 1.5; color: var(--color-text-subtle, var(--color-text-muted)); }
.plugin-host__spinner { width: 16px; height: 16px; border: 2px solid var(--color-border); border-top-color: var(--color-primary); border-radius: 50%; animation: plugin-host-spin .8s linear infinite; }
@keyframes plugin-host-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .plugin-host__spinner { animation: none; } }
</style>