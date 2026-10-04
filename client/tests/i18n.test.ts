/**
 * 宿主 i18n 基础设施单测（P6 从 client/tests/widgets/settings.test.ts 拆出）。
 *
 * ## 为什么拆
 *
 * 那个文件原本把三件不相关的事塞在一起：主题基础设施、i18n 基础设施、
 * SettingsPaneView 组件渲染。P6 把设置组件搬进 workbench 插件之后，
 * 留在 client 的只剩前两件 —— 而它们本来就该分开：
 * · 主题归 `@osteosome/core-client`（见 sdk/core-client/tests/useTheme.test.ts）
 * · i18n 归宿主自己（这个文件）
 * · 设置组件归 workbench 插件（见 plugins/workbench/ui/tests/settings.test.ts）
 *
 * 一个文件同时测三处，等于三处里搬走任何一处都要回来改这个文件；
 * 而「改设置组件的测试」和「改宿主的 i18n」本来不该是同一次改动。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { i18n, initLocale, currentLocale, DEFAULT_LOCALE } from '../src/i18n'

beforeEach(() => {
  ;(i18n.global.locale as { value: string }).value = DEFAULT_LOCALE
})

describe('initLocale', () => {
  it('读 preferences 恢复 locale（en）', async () => {
    await initLocale(async () => ({ 'ui.locale': 'en' }))
    expect((i18n.global.locale as { value: string }).value).toBe('en')
  })

  it('无 locale / 非法 → 默认 zh-CN', async () => {
    await initLocale(async () => ({}))
    expect((i18n.global.locale as { value: string }).value).toBe(DEFAULT_LOCALE)

    await initLocale(async () => ({ 'ui.locale': 'fr-FR' }))
    expect((i18n.global.locale as { value: string }).value).toBe(DEFAULT_LOCALE)
  })

  it('preferences 读失败 → 保持默认 locale，不阻塞启动', async () => {
    await initLocale(async () => {
      throw new Error('prefs unavailable')
    })
    expect((i18n.global.locale as { value: string }).value).toBe(DEFAULT_LOCALE)
  })

  it('currentLocale 与 vue-i18n 的值一致', () => {
    ;(i18n.global.locale as { value: string }).value = 'en'
    expect(currentLocale()).toBe('en')
  })
})

describe('宿主文案命名空间（P6 后只剩 common 与 llm）', () => {
  it('common.* 与 llm.* 均可达', () => {
    expect(i18n.global.t('common.save')).toBeTruthy()
    expect(i18n.global.t('llm.provider')).toBeTruthy()
  })

  it('settings.* 不再由宿主提供 —— 它随设置组件搬进了 workbench 插件', () => {
    /**
     * `t()` 对不存在的 key 会返回 key 本身，所以这里要断言「返回值等于 key」，
     * 而不是断言 `not.toBeTruthy()`（那对非空字符串恒真，写了等于没写）。
     *
     * 这条断言的作用是**防止有人把 settings 文案又搬回宿主**。
     * 它现在通过，是因为 P6 摘掉了宿主 i18n 里的 settings 命名空间。
     */
    expect(i18n.global.t('settings.tabs.ui')).toBe('settings.tabs.ui')
  })

  it('zh-CN 与 en 的 key 集合一致（漏翻译不会在运行期才暴露成裸 key）', () => {
    const flatten = (obj: object, prefix = ''): string[] =>
      Object.entries(obj).flatMap(([k, v]) =>
        v && typeof v === 'object'
          ? flatten(v as object, `${prefix}${k}.`)
          : [`${prefix}${k}`],
      )
    const zh = flatten((i18n.global.messages.value as Record<string, object>)['zh-CN'])
    const en = flatten((i18n.global.messages.value as Record<string, object>).en)
    expect(zh.filter((k) => !en.includes(k))).toEqual([])
    expect(en.filter((k) => !zh.includes(k))).toEqual([])
  })
})