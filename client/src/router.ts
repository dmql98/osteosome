import {
  createRouter,
  createWebHashHistory,
  type Router,
  type RouterHistory,
  type RouteRecordRaw,
} from 'vue-router'

export const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'main',
    component: () => import('./layouts/MainLayout.vue'),
  },
  {
    path: '/pane/:id',
    name: 'pane',
    component: () => import('./panes/PanelHost.vue'),
    props: (route) => ({
      id: String(route.params.id),
      widgets: String(route.query.w ?? '').split(',').map((item) => item.trim()).filter(Boolean),
    }),
  },
  {
    // 插件管理是**一个**窗口：列表与详情在窗内切换（见 plugins/PluginManagerWindow.vue）
    path: '/plugin-list',
    name: 'plugin-list',
    component: () => import('./plugins/PluginManagerWindow.vue'),
  },
  {
    // 保留深链：直接落到某个插件的配置页，但仍是同一个窗口，不再新建窗口
    path: '/plugin-detail/:id',
    name: 'plugin-detail',
    component: () => import('./plugins/PluginManagerWindow.vue'),
    props: (route) => ({ initialPluginId: String(route.params.id) }),
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/',
  },
]

export function createAppRouter(history: RouterHistory = createWebHashHistory()): Router {
  return createRouter({ history, routes })
}

export const router = createAppRouter()
