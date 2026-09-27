import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import { UiPlugin } from './components/ui'
import './styles/tokens.css'
import './styles/base.css'
import 'dockview-vue/dist/styles/dockview.css'
import 'vue-movable-box/style.css'

const app = createApp(App)
app.use(createPinia())
app.use(UiPlugin)
app.use(router)
app.mount('#app')

// 独立窗初始摆位（磁吸/跟随已下沉到 Rust 壳）：无需启动时初始化，开窗时再摆位
