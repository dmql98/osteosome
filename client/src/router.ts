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
    path: '/plugin-list',
    name: 'plugin-list',
    component: () => import('./plugins/PluginListWindow.vue'),
  },
  {
    path: '/plugin-detail/:id',
    name: 'plugin-detail',
    component: () => import('./plugins/PluginDetailWindow.vue'),
    props: (route) => ({ pluginId: String(route.params.id) }),
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
