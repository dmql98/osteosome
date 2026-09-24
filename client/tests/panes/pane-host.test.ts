import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { createPinia } from 'pinia'
import PaneHost from '../../src/panes/PaneHost.vue'
import { sse } from '../../src/core-sdk/sse'

describe('PaneHost', () => {
  it('渲染已注册 Pane，未知 Pane 显示错误占位', () => {
    const known = mount(PaneHost, { props: { id: 'pane.hello' }, global: { plugins: [createPinia()] } })
    expect(known.find('.pane-host__bar').text()).toContain('Hello')
    const unknown = mount(PaneHost, { props: { id: 'pane.missing' }, global: { plugins: [createPinia()] } })
    expect(unknown.find('[role="alert"]').text()).toContain('不存在')
    sse.close()
  })
})
