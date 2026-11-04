/**
 * `ModelPickerModal` 的行为单测。
 *
 * ## 为什么单独一个文件
 *
 * 它是「获取模型列表 → 勾选 → 采纳」这条链里唯一有状态的一段（候选 ∪ 已配置 ∪ 手填），
 * 而这段状态的每个边界都对应一个真实的坏果：
 * - 没配过却只勾了一部分 → 用户拉了一次却没采纳到东西；
 * - 已配置但上游没返回的模型被丢掉 → 一次「获取模型列表」偷偷删了手填的模型；
 * - 全选连隐藏（被搜索过滤掉）的一起改 → 用户看不见的条目被删。
 *
 * 这些用一张小表逐个钉住，比在整页用例里间接断言清楚得多。
 *
 * ## 为什么在 `document.body` 里查、以及为什么不用 `wrapper.emitted()`
 *
 * `Modal` 走 `Teleport`（`sdk/ui` 的约定），内容不在 wrapper 的子树里 ——
 * `wrapper.find` 找不到它，只能查 DOM。
 *
 * 而 `wrapper.emitted()` 在这套组合（vue 3.5 + VTU + jsdom）下**收不到**子组件
 * 在模态里发出的那些事件（实测：处理函数确实跑了、`emit` 确实调了，`emitted()` 仍是空对象）。
 * 所以这里用「监听器当 props 传进去、记在本地数组里」的办法断言契约 ——
 * 它断的是**组件真的调用了监听器**，比断言 VTU 的内部记账更贴近契约本身。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ModelPickerModal from '../src/views/ModelPickerModal.vue'

/** 一次挂载记下的两次回调：采纳了什么、弹窗被要求关成什么 */
interface Recording {
  confirmed: string[][]
  closes: boolean[]
}

function mountPicker(overrides: Record<string, unknown> = {}): Recording {
  const recording: Recording = { confirmed: [], closes: [] }
  mount(ModelPickerModal, {
    props: {
      open: true,
      endpointId: 'my-proxy',
      endpointLabel: '',
      candidates: [] as string[],
      selected: [] as string[],
      catalog: null as 'remote' | 'static' | null,
      ...overrides,
      onConfirm: (models: string[]) => recording.confirmed.push(models),
      'onUpdate:open': (value: boolean) => recording.closes.push(value),
    },
    attachTo: document.body,
  })
  return recording
}

/** 表格里每一条的勾选状态（顺序与渲染顺序一致） */
function checkedRows(): boolean[] {
  return Array.from(document.body.querySelectorAll<HTMLInputElement>('.ui-checkbox__input')).map(
    (input) => input.checked,
  )
}

function clickTestId(id: string): void {
  const el = document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  if (!el) throw new Error(`找不到 [data-testid="${id}"]`)
  el.click()
}

/** 点一行：勾选框本体才是真正的开关（label 的激活行为在 jsdom 里不可靠） */
function clickRow(model: string): void {
  const label = document.body.querySelector<HTMLElement>(`[data-testid="model-pick-${model}"]`)
  if (!label) throw new Error(`找不到模型行 ${model}`)
  const input = label.querySelector<HTMLInputElement>('input')
  if (!input) throw new Error(`模型行 ${model} 里没有勾选框`)
  input.click()
}

function typeInto(placeholderIncludes: string, value: string): void {
  const input = Array.from(document.body.querySelectorAll<HTMLInputElement>('input')).find((i) =>
    (i.placeholder ?? '').includes(placeholderIncludes),
  )
  if (!input) throw new Error(`找不到 placeholder 含「${placeholderIncludes}」的输入框`)
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ModelPickerModal', () => {
  it('没配过清单 → 候选默认全勾；保存回传整份候选', async () => {
    const rec = mountPicker({ candidates: ['gpt-4o-mini', 'qwen2.5-7b'], catalog: 'remote' })
    await flushPromises()

    expect(checkedRows()).toEqual([true, true])
    clickTestId('model-picker-save')
    await flushPromises()

    // 「我刚拉到的就是我要的」是绝大多数情况 —— 默认全勾省掉一次全选点击
    expect(rec.confirmed).toEqual([['gpt-4o-mini', 'qwen2.5-7b']])
    expect(rec.closes.at(-1)).toBe(false)
  })

  it('配过清单 → 只勾已配置的；新勾上的候选一并保存', async () => {
    const rec = mountPicker({
      candidates: ['gpt-4o-mini', 'qwen2.5-7b'],
      selected: ['gpt-4o-mini'],
      catalog: 'remote',
    })
    await flushPromises()

    // 已配置的勾上、新拉到的**不**自动进配置 —— 否则「获取模型列表」= 无声采纳
    expect(checkedRows()).toEqual([true, false])
    clickRow('qwen2.5-7b')
    await flushPromises()
    clickTestId('model-picker-save')
    await flushPromises()

    expect(rec.confirmed).toEqual([['gpt-4o-mini', 'qwen2.5-7b']])
  })

  it('上游没返回的已配置模型也列出来，取消勾选才算移除', async () => {
    const rec = mountPicker({
      candidates: ['gpt-4o-mini'],
      // 手填的模型名 / 上游这次没列全的模型 —— 保存时必须留着，除非用户取消勾
      selected: ['gpt-4o-mini', 'my-legacy-model'],
      catalog: 'remote',
    })
    await flushPromises()

    expect(document.body.textContent).toContain('my-legacy-model')
    expect(checkedRows()).toEqual([true, true])
    clickRow('my-legacy-model')
    await flushPromises()
    clickTestId('model-picker-save')
    await flushPromises()

    expect(rec.confirmed).toEqual([['gpt-4o-mini']])
  })

  it('上游没有清单时给手填入口；手填的条目直接进清单', async () => {
    const rec = mountPicker({ candidates: [], selected: [], catalog: 'static' })
    await flushPromises()

    // 连不上 / 上游没有 /models 是自建网关的常态，这条路径不能是死路
    expect(document.body.textContent).toContain('手动添加模型名')
    typeInto('手动添加模型名', 'qwen2.5:7b')
    await flushPromises()
    clickTestId('model-picker-add')
    await flushPromises()

    expect(checkedRows()).toEqual([true])
    clickTestId('model-picker-save')
    await flushPromises()
    expect(rec.confirmed).toEqual([['qwen2.5:7b']])
  })

  it('全选只作用于当前可见的条目（搜索过滤掉的保持原样）', async () => {
    const rec = mountPicker({
      candidates: ['qwen2.5-7b', 'qwen2.5-3b', 'gpt-4o-mini'],
      selected: ['gpt-4o-mini'],
      catalog: 'remote',
    })
    await flushPromises()
    // 初始：已配置的排在最前并勾上，两个新候选未勾
    expect(checkedRows()).toEqual([true, false, false])

    typeInto('搜索模型名', 'qwen')
    await flushPromises()
    clickTestId('model-picker-select-all')
    await flushPromises()
    // 可见的两个都被勾上 → 按钮文案翻成「取消全选」
    expect(document.body.textContent).toContain('取消全选')

    clickTestId('model-picker-save')
    await flushPromises()
    // gpt 被搜索过滤掉了，但它已配置，不能被这次全选顺手删掉
    expect(rec.confirmed).toEqual([['gpt-4o-mini', 'qwen2.5-7b', 'qwen2.5-3b']])
  })

  it('取消勾选后保存 → 该模型从清单里移除', async () => {
    const rec = mountPicker({
      candidates: ['gpt-4o-mini'],
      selected: ['gpt-4o-mini'],
      catalog: 'remote',
    })
    await flushPromises()
    clickRow('gpt-4o-mini')
    await flushPromises()
    clickTestId('model-picker-save')
    await flushPromises()
    // 空数组是合法结果（= 不要静态清单，只靠探测），这里不该拦
    expect(rec.confirmed).toEqual([[]])
  })
})
