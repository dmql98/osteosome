/**
 * workbench 设置页单测（P6）。
 *
 * 从 `client/tests/widgets/settings.test.ts` 搬来 —— 组件搬进插件，测试跟着走。
 *
 * ## 这里断言的是什么
 *
 * 「设置页里没有 LLM tab」。这条断言看着简单，但它是 P6 之前一段错配的**遗留护栏**：
 * LLM 曾被塞在设置页里，直到 S7-7 才拆成独立的 `widget.llm-settings`。
 * 拆完之后，把 LLM 塞回设置页会同时破坏两个模型：它既不属于 workbench，
 * 也已经有独立 widget id 了。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SettingsPaneView from '../src/views/SettingsPaneView.vue'
import { i18n, DEFAULT_LOCALE } from '../src/i18n'

beforeEach(() => {
  ;(i18n.global.locale as { value: string }).value = DEFAULT_LOCALE
  document.documentElement.removeAttribute('data-theme')
  // 插件 UI 里的组件可能发 fetch（/api/info、/api/command），这里兜底，
  // 否则 jsdom 的 "not implemented: navigation" 会把用例搞成难以定位的失败
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 })))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('SettingsPaneView', () => {
  it('渲染 界面 / 高级 两个 Tab（插件 i18n 文案）', async () => {
    const wrapper = mount(SettingsPaneView, { global: { plugins: [i18n] } })
    await flushPromises()
    const text = wrapper.text()
    expect(text).not.toContain('LLM')
    expect(text).toContain('界面')
    expect(text).toContain('高级')
  })

  it('settings.* 命名空间由插件自己提供（不再是宿主的）', () => {
    // 插件有一份独立的 vue-i18n 实例（跨 iframe，拿不到宿主那份）
    expect(i18n.global.t('settings.tabs.ui')).not.toBe('settings.tabs.ui')
    expect(i18n.global.t('settings.tabs.llm')).not.toBe('LLM')
  })

  it('zh-CN 与 en 的 settings.* key 集合一致', () => {
    const flatten = (obj: object, prefix = ''): string[] =>
      Object.entries(obj).flatMap(([k, v]) =>
        v && typeof v === 'object' ? flatten(v as object, `${prefix}${k}.`) : [`${prefix}${k}`],
      )
    const messages = i18n.global.messages.value as Record<string, Record<string, object>>
    const zh = flatten(messages['zh-CN'])
    const en = flatten(messages.en)
    expect(zh.filter((k) => !en.includes(k))).toEqual([])
    expect(en.filter((k) => !zh.includes(k))).toEqual([])
  })
})