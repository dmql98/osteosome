import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import { UiPlugin } from './components/ui'
import './styles/tokens.css'
import './styles/base.css'
import 'dockview-vue/dist/styles/dockview.css'

const app = createApp(App)
app.use(createPinia())
app.use(UiPlugin)
app.use(router)
app.mount('#app')
