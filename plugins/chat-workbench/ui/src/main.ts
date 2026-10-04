/**
 * chat-workbench 插件 UI 的入口（P6）。
 *
 * 它挂在**三个** iframe 里（会话列表 / 时间线 / 输入框），每一个都由 Core 用
 * `http://127.0.0.1:4317/plugins/chat-workbench/ui/index.html#<view>` 伺服 ——
 * **三者与宿主同源，且三者之间也同源**。这一条决定了下面所有做法：
 *
 * · `fetch('/api/command')` / `/api/preferences` / `/events` 直接可用，
 *   不需要跨域配置、令牌或 postMessage 握手。
 * · 三个 iframe 之间共享状态**不需要消息层**：同源 + 各自订阅同一批 SSE 事件，
 *   各自拼出的视图必然一致。唯一需要显式传的是 `curId`（服务端没有这个概念），
 *   走 `sessionStorage` + `storage` 事件 —— 见 `state/session-sync.ts`。
 *
 * 没有 pinia、没有 router：状态在 `state/` 里按「谁需要它」切好，
 * 每个 iframe 里只有一个视图用自己那份。
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
 *
 * **三个 iframe 都会发这一句** —— 宿主那边按 `event.source` 逐个对上号，
 * 不需要「哪个视图就绪」的信息（见 `PluginWidgetHost.vue`）。
 */
window.parent?.postMessage({ type: 'osteosome:plugin-ui:ready', src: window.location.pathname }, window.location.origin)