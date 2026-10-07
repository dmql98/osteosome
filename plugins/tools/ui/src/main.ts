/** tools 插件 UI 入口（P7）。同源 iframe。 */
import { createApp } from 'vue'
import App from './App.vue'
import '@osteosome/ui/styles/tokens.css'
import '@osteosome/ui/styles/base.css'

const container = document.getElementById('app')
if (!container) throw new Error('#app not found')
createApp(App).mount(container)

window.parent?.postMessage({ type: 'osteosome:plugin-ui:ready', src: window.location.pathname }, window.location.origin)
