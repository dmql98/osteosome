/**
 * 对话布局预设单测（S6）—— 三盒几何。
 *
 * 守两件事：
 * 1. 几何本身：① 左固定宽、② 右侧占满剩余、③ 右侧底部固定高，且**不重叠、不出负、不溢出**
 * 2. 「flex」在绝对定位下是按画布现算的 —— 所以画布变大，占满剩余的那两栏要跟着变宽
 */
import { describe, expect, it } from 'vitest'
import { CHAT_BOX, chatThreeBoxRects, chatThreeBoxRectsFor } from '../../src/panes/default-layout'

/** MovableBoxRect 的 left/top/width/height 是 `string | number`（支持 % 单位），算术前显式取数 */
function px(v: string | number | undefined): number {
  return typeof v === 'number' ? v : Number.parseFloat(v ?? '0')
}

describe('chatThreeBoxRects（三盒几何）', () => {
  it('三个盒子都有 rect，且 key 就是三个 widget id', () => {
    const rects = chatThreeBoxRects(1200, 800)
    expect(Object.keys(rects).sort()).toEqual([CHAT_BOX.composer, CHAT_BOX.sessions, CHAT_BOX.timeline].sort())
  })

  it('① 会话列在左，固定 240px 宽，占满高度', () => {
    const s = chatThreeBoxRects(1200, 800)[CHAT_BOX.sessions]
    expect(px(s.left)).toBe(8)
    expect(px(s.width)).toBe(240)
    expect(px(s.height)).toBe(800 - 16)
  })

  it('② 对话在右上，宽度吃掉会话列之外的全部空间', () => {
    const rects = chatThreeBoxRects(1200, 800)
    const s = rects[CHAT_BOX.sessions]
    const t = rects[CHAT_BOX.timeline]
    expect(px(t.left)).toBe(px(s.left) + px(s.width) + 8)
    expect(px(t.left) + px(t.width)).toBe(1200 - 8)
  })

  it('③ 输入在右下，固定 120px 高，与② 同宽同左', () => {
    const rects = chatThreeBoxRects(1200, 800)
    const t = rects[CHAT_BOX.timeline]
    const c = rects[CHAT_BOX.composer]
    expect(px(c.left)).toBe(px(t.left))
    expect(px(c.width)).toBe(px(t.width))
    expect(px(c.height)).toBe(120)
    // 紧贴在② 下方（一个 gap）
    expect(px(c.top)).toBe(px(t.top) + px(t.height) + 8)
  })

  it('② + ③ 的高度之和不超过画布（不溢出）', () => {
    const H = 800
    const rects = chatThreeBoxRects(1200, H)
    const t = rects[CHAT_BOX.timeline]
    const c = rects[CHAT_BOX.composer]
    expect(px(c.top) + px(c.height)).toBeLessThanOrEqual(H - 8)
    expect(px(t.height)).toBeGreaterThan(0)
  })

  it('「flex」按画布现算：画布变宽，吃掉剩余的那两栏跟着变宽', () => {
    const narrow = chatThreeBoxRects(1000, 800)
    const wide = chatThreeBoxRects(1600, 800)
    expect(px(wide[CHAT_BOX.timeline].width)).toBeGreaterThan(px(narrow[CHAT_BOX.timeline].width))
    // 会话列是固定的，不随画布变
    expect(px(wide[CHAT_BOX.sessions].width)).toBe(px(narrow[CHAT_BOX.sessions].width))
  })

  it('窄画布：固定值按比例收缩，宽高都不为负且不溢出（不做窄窗降级，但也不能溢出画布）', () => {
    const rects = chatThreeBoxRects(320, 200)
    for (const rect of Object.values(rects)) {
      expect(px(rect.width)).toBeGreaterThanOrEqual(0)
      expect(px(rect.height)).toBeGreaterThanOrEqual(0)
      expect(px(rect.left) + px(rect.width)).toBeLessThanOrEqual(320)
      expect(px(rect.top) + px(rect.height)).toBeLessThanOrEqual(200)
    }
  })

  it('量不到画布尺寸时用兜底值（全 0 会让盒子叠在左上角）', () => {
    const rects = chatThreeBoxRectsFor(null)
    expect(px(rects[CHAT_BOX.sessions].width)).toBe(240)
    expect(px(rects[CHAT_BOX.timeline].width)).toBeGreaterThan(0)
  })

  it('画布元素给了尺寸就用它给的', () => {
    const rects = chatThreeBoxRectsFor({ clientWidth: 1400, clientHeight: 900 })
    expect(px(rects[CHAT_BOX.sessions].height)).toBe(900 - 16)
  })
})

/**
 * 预设 vs 已保存几何的优先级（PanelContainer 的契约）。
 *
 * 「拖完能一键复位」的前提是：**用户拖过的位置不能被预设覆盖**，而复位后预设要重新生效。
 * 这条优先级写在 PanelContainer.rebuild 里，这里用纯函数复刻同一顺序来守它 ——
 * 比起挂载整个 PanelContainer（要 mock dockview + movable-box），复刻更能说明契约本身。
 */
describe('初始几何的优先级', () => {
  const saved: Record<string, { left: number; top: number; width: number; height: number; zIndex: number }> = {
    [CHAT_BOX.sessions]: { left: 999, top: 111, width: 300, height: 222, zIndex: 9 },
  }

  function pick(id: string, index: number): { left: string | number } {
    const presets = chatThreeBoxRectsFor(null)
    return saved[id] ?? presets[id] ?? { left: 8 + index * 368 }
  }

  it('用户拖过的盒子用保存的 rect，不被预设覆盖', () => {
    expect(px(pick(CHAT_BOX.sessions, 0).left)).toBe(999)
  })

  it('没拖过的盒子用三盒预设', () => {
    const presets = chatThreeBoxRectsFor(null)
    expect(px(pick(CHAT_BOX.timeline, 1).left)).toBe(px(presets[CHAT_BOX.timeline].left))
  })

  it('复位 = 清掉保存的 rect → 预设重新生效（这就是「一键复位」的实现）', () => {
    const presets = chatThreeBoxRectsFor(null)
    expect(px(presets[CHAT_BOX.sessions].left)).toBe(8)
    expect(px(presets[CHAT_BOX.sessions].left)).not.toBe(999)
  })
})