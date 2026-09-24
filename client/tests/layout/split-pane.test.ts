import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import SplitPane from '../../src/components/layout/SplitPane.vue'

describe('SplitPane', () => {
  it('键盘调整 ratio 并限制最小比例', async () => {
    const wrapper = mount(SplitPane, { props: { direction: 'horizontal', initialRatio: 0.2, min: 0.15 } })
    await wrapper.find('[role="separator"]').trigger('keydown.left')
    expect(wrapper.emitted('update:ratio')).toEqual([[0.15]])
  })
})
