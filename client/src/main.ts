import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import { UiPlugin } from './components/ui'
import { initSnapFeedback } from './tauri/snap-feedback'
import './styles/tokens.css'
import './styles/base.css'
import 'dockview-vue/dist/styles/dockview.css'
import 'vue-movable-box/style.css'

const app = createApp(App)
app.use(createPinia())
app.use(UiPlugin)
app.use(router)
app.mount('#app')

// 独立窗吸附反馈：贴边瞬间的高亮脉冲（磁吸/跟随本身已下沉到 Rust 壳）
void initSnapFeedback()
