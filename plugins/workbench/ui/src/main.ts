/**
 * 插件 UI 的入口（P6）。
 *
 * 它挂在一个 iframe 里，而这个 iframe 由 Core 用 `http://127.0.0.1:4317/plugins/workbench/ui/`
 * 伺服 —— **与宿主同源**。这一条决定了下面所有做法：
 *
 * · `fetch('/api/command')` / `/api/preferences` / `/events` 直接可用，
 *   不需要任何跨域配置、令牌或 postMessage 握手。
 * · `localStorage` / `BroadcastChannel` 可用（跨 iframe 共享状态的基础）。
 *
 * ## 没有 pinia、没有 router
 *
 * 六个视图各自独立：各自订阅 SSE、各自读偏好、各自发命令。
 * 它们之间**没有需要共享的状态** —— 事实上 P6 之前它们同处一个 Vue 应用，
 * 靠 pinia 单例隐式共享，而其中真正共享的部分（服务状态表）已经抽成
 * `@osteosome/core-client` 里的一张模块级表。
 *
 * 引入 pinia / router 只会让「一个插件的六个页面」变成「半个应用」——
 * 而 iframe 之间的通信（chat-workbench 三盒要传的东西）本来就**不能**靠它们解决：
 * 每个视图是独立 iframe，各有一个 Vue 实例。
 */
import { createApp } from 'vue'
import App from './App.vue'
import { i18n } from './i18n'
import '@osteosome/ui/styles/tokens.css'
import '@osteosome/ui/styles/base.css'

const container = document.getElementById('app')
if (!container) throw new Error('#app not found')

createApp(App).use(i18n).mount(container)

/**
 * 「我准备好了」握手 —— 给宿主的 `PluginWidgetHost` 一个确定的成功信号。
 *
 * 宿主不能只看 `load`：那只说明 index.html 到手，插件自己的 chunk 404 时它照样触发，
 * 而 iframe 的 `error` 事件对 HTTP 错误不触发。于是唯一可靠的信号是插件自己说一声。
 *
 * 显式给 origin：`'*'` 会把消息广播给任何嵌入者。
 */
window.parent?.postMessage(
  { type: 'osteosome:plugin-ui:ready', src: window.location.pathname },
  window.location.origin,
)