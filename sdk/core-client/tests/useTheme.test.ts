/**
 * 主题基础设施单测（P6 从 client/tests/widgets/settings.test.ts 拆出）。
 *
 * ## 为什么搬到这里
 *
 * `useTheme` / `initTheme` 的实现现在住在 `@osteosome/core-client`。
 * 测试留在 client 会变成「测一个转手的东西」：它 import 的是 client 的 shim，
 * 而 shim 只做 re-export —— 于是这条用例测的是「shim 存在」而不是「主题逻辑对」，
 * 真正的实现改了它也不一定红。
 *
 * 更实际的问题是没有第二个人会因为改坏主题而来改 client 的测试。
 * 测试归属跟被测物走。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { initTheme, useTheme, DEFAULT_THEME } from '../src/useTheme'

beforeEach(() => {
  // initTheme / setTheme 都直接写 DOM，测试之间必须复位，
  // 否则「第一条用例设了 dark」会静默污染后面所有用例的起点
  document.documentElement.removeAttribute('data-theme')
})

describe('useTheme / initTheme', () => {
  it('initTheme 挂载即读 preferences → 设 data-theme（dark 恢复）', async () => {
    await initTheme(async () => ({ 'ui.theme': 'dark' }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('preferences 无 theme → 默认 light', async () => {
    await initTheme(async () => ({}))
    expect(document.documentElement.getAttribute('data-theme')).toBe(DEFAULT_THEME)
  })

  it('preferences 里 theme 是非法值 → 默认 light（不写脏值进 DOM）', async () => {
    await initTheme(async () => ({ 'ui.theme': 'neon' }))
    expect(document.documentElement.getAttribute('data-theme')).not.toBe('neon')
  })

  it('setTheme 即时改 DOM（不等刷新）', () => {
    const { setTheme } = useTheme()
    setTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    setTheme('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('preferences 读失败 → 显式落回默认主题，不阻塞启动', async () => {
    /**
     * 断言的是「显式写成 light」而不是「DOM 上没这个属性」。
     *
     * 后者也是种合理实现（什么都不做，让 CSS 的默认变量生效），但它有个坏处：
     * 上一次运行时留在 DOM 上的 `data-theme` 会**留着** —— 读 preferences 失败
     * + 复用同一个 document（测试里正是如此，浏览器刷新里也近似如此）
     * 会得到一个「以为读到了、其实没读」的状态。显式回落把这个歧义消掉了。
     */
    document.documentElement.setAttribute('data-theme', 'dark')
    await initTheme(async () => {
      throw new Error('prefs unavailable')
    })
    expect(document.documentElement.getAttribute('data-theme')).toBe(DEFAULT_THEME)
  })
})