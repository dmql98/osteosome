/**
 * 插件 UI 的入口（P5）。
 *
 * 它挂在一个 iframe 里，而这个 iframe 由 Core 用 `http://127.0.0.1:4317/plugins/models/ui/`
 * 伺服 —— **与宿主同源**。这一条决定了下面所有做法：
 *
 * · `fetch('/api/command')` / `/api/preferences` / `/events` 直接可用，
 *   不需要任何跨域配置、令牌或 postMessage 握手。
 * · `localStorage` / `BroadcastChannel` 可用（跨 iframe 共享状态的基础）。
 *
 * 没有 pinia、没有 router：这块 UI 只有一个视图，状态全在组件里。
 * 引入它们只会让「一个插件的界面」变成「半个应用」。
 */
import { createApp } from 'vue'
import App from './App.vue'
import '@osteosome/ui/styles/tokens.css'
import '@osteosome/ui/styles/base.css'

const container = document.getElementById('app')
if (!container) throw new Error('#app not found')

createApp(App).mount(container)

/**
 * 「我准备好了」握手 —— 给宿主的 `PluginWidgetHost` 一个确定的成功信号。
 *
 * 为什么宿主要等这句话而不是只看 `load`：
 * `load` 只说明 index.html 到手，插件自己的 chunk 404 时它**照样触发**，
 * 而 iframe 的 `error` 事件对 HTTP 错误不触发。于是唯一可靠的信号是插件自己说一声。
 *
 * `parent.postMessage(msg, location.origin)` 显式给 origin：
 * `'*'` 会把这个消息广播给任何嵌入者，而这条消息里没有敏感内容也没必要冒这个险。
 */
window.parent?.postMessage({ type: 'osteosome:plugin-ui:ready', src: window.location.pathname }, window.location.origin)