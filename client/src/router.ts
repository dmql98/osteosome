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
    component: () => import('./panes/PaneHost.vue'),
    props: true,
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
