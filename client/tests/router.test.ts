import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { createMemoryHistory } from 'vue-router'
import { createPinia } from 'pinia'
import App from '../src/App.vue'
import { createAppRouter } from '../src/router'

async function mountAt(path: string) {
  const router = createAppRouter(createMemoryHistory())
  const wrapper = mount(App, { global: { plugins: [router, createPinia()], stubs: { DockviewLayout: true } } })
  await router.push(path)
  await router.isReady()
  await flushPromises()
  return { router, wrapper }
}

describe('router · 三入口', () => {
  it('/ 命中 MainLayout（TopBar 渲染）', async () => {
    const { router, wrapper } = await mountAt('/')
    expect(router.currentRoute.value.name).toBe('main')
    expect(wrapper.find('.top-bar').exists()).toBe(true)
  })

  it('/pane/:id 命中 PaneHost 且渲染 pane id', async () => {
    const { router, wrapper } = await mountAt('/pane/pane.hello')
    expect(router.currentRoute.value.name).toBe('pane')
    expect(router.currentRoute.value.params.id).toBe('pane.hello')
    expect(wrapper.find('.pane-host__bar').text()).toContain('Hello')
    expect(wrapper.find('.pane-host__bar').text()).toContain('pane.hello')
  })

  it('未匹配路径重定向到主窗', async () => {
    const { router, wrapper } = await mountAt('/no-such-route')
    expect(router.currentRoute.value.path).toBe('/')
    expect(router.currentRoute.value.name).toBe('main')
    expect(wrapper.find('.top-bar').exists()).toBe(true)
  })
})

describe('App 装配纪律', () => {
  it('App 只渲染 RouterView（不含业务面板清单）', () => {
    const wrapper = mount(App, {
      global: { stubs: { RouterView: { template: '<div class="router-view-stub" />' } } },
    })
    expect(wrapper.find('.router-view-stub').exists()).toBe(true)
    expect(wrapper.find('.top-bar').exists()).toBe(false)
    expect(wrapper.find('.pane-host').exists()).toBe(false)
  })
})

describe('createAppRouter', () => {
  it('缺省 history 走 hash 模式（弹窗 URL 稳定 / file:// 兼容）', () => {
    const router = createAppRouter()
    expect(String(router.options.history.base)).toContain('#')
  })

  it('路由表固定三条', () => {
    const router = createAppRouter(createMemoryHistory())
    const paths = router.getRoutes().map((r) => r.path).sort()
    expect(paths).toEqual(['/', '/:pathMatch(.*)*', '/pane/:id'].sort())
  })
})
