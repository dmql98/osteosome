import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Tooltip from '../../src/components/ui/Tooltip.vue'

describe('Tooltip', () => {
  it('hover 后显示 role=tooltip 内容', async () => {
    const wrapper = mount(Tooltip, { props: { content: '说明' }, slots: { default: '<button>触发</button>' } })
    await wrapper.trigger('focusin')
    expect(wrapper.find('[role="tooltip"]').text()).toBe('说明')
  })
})
