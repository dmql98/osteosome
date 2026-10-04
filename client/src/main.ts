import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import { UiPlugin } from './components/ui'
import { i18n, initLocale } from './i18n'
import { initTheme } from './core-sdk/useTheme'
import { usePreferences } from './core-sdk/usePreferences'
import { initSnapFeedback } from './tauri/snap-feedback'
// P6：tokens / base 随组件一起进了 `@osteosome/ui`（宿主与插件各引一份 CSS，
// 值由 core/tests/tokens-parity.test.ts 对账）
import '@osteosome/ui/styles/tokens.css'
import '@osteosome/ui/styles/base.css'
import 'dockview-vue/dist/styles/dockview.css'
import 'vue-movable-box/style.css'

const app = createApp(App)
app.use(createPinia())
app.use(UiPlugin)
app.use(i18n)
app.use(router)
app.mount('#app')

// 挂载即读 preferences：主题 / 语言刷新即生效（不等异步完成——默认 light / zh-CN 先出）
void initTheme(usePreferences().get)
void initLocale(usePreferences().get)

// 独立窗吸附反馈：贴边瞬间的高亮脉冲（磁吸/跟随本身已下沉到 Rust 壳）
void initSnapFeedback()
