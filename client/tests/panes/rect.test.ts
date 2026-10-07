import { describe, expect, it } from 'vitest'
import { FALLBACK_H, FALLBACK_W, canvasSize, savedRectToPercent, snapRectToGrid, toPercent } from '../../src/panes/rect'

/**
 * 盒子几何相对化（rect.ts）
 *
 * rect 从绝对像素改成「占画布的百分比」—— 工作台缩放时盒子按比例跟着变。
 * 这里锁的是换算本身：分母、越界钳制、字符串输入、老布局的单位解释。
 */
describe('toPercent：像素 → 百分比', () => {
  it('按画布宽高分别换算，zIndex 原样保留', () => {
    const rect = toPercent({ left: 100, top: 50, width: 400, height: 300, zIndex: 7 }, 1000, 500)
    expect(rect.left).toBeCloseTo(10, 4)
    expect(rect.top).toBeCloseTo(10, 4)
    expect(rect.width).toBeCloseTo(40, 4)
    expect(rect.height).toBeCloseTo(60, 4)
    expect(rect.zIndex).toBe(7)
  })

  it('负值钳到 0，越界钳到 100（盒子不允许跑出画布）', () => {
    const rect = toPercent({ left: -40, top: -10, width: 2000, height: 900 }, 1000, 500)
    expect(rect.left).toBe(0)
    expect(rect.top).toBe(0)
    expect(rect.width).toBe(100)
    expect(rect.height).toBe(100)
  })

  it('接受字符串形式的像素值（MovableBoxRect 允许 string）', () => {
    const rect = toPercent({ left: '200', top: '100', width: '500', height: '250' }, 1000, 500)
    expect(rect.left).toBeCloseTo(20, 4)
    expect(rect.top).toBeCloseTo(20, 4)
    expect(rect.width).toBeCloseTo(50, 4)
    expect(rect.height).toBeCloseTo(50, 4)
  })

  it('脏值（NaN / 缺失）当 0 处理，不会算出 NaN 撑坏布局', () => {
    const rect = toPercent({ left: Number.NaN, top: undefined as unknown as number, width: 0, height: 0 }, 1000, 500)
    expect(rect.left).toBe(0)
    expect(rect.top).toBe(0)
    expect(Number.isNaN(rect.width as number)).toBe(false)
  })

  it('分母绝不为 0：画布量不到也不会除出 Infinity', () => {
    const rect = toPercent({ left: 100, top: 100, width: 100, height: 100 }, 0, 0)
    expect(Number.isFinite(rect.left as number)).toBe(true)
    expect(Number.isFinite(rect.width as number)).toBe(true)
    expect(rect.width).toBeLessThanOrEqual(100)
  })
})

describe('canvasSize：画布尺寸 + 兜底', () => {
  it('量得到就用真实尺寸', () => {
    expect(canvasSize({ clientWidth: 800, clientHeight: 600 })).toEqual({ width: 800, height: 600 })
  })

  it('量不到（0 / null）退回兜底，换算分母永远有效', () => {
    expect(canvasSize({ clientWidth: 0, clientHeight: 0 })).toEqual({ width: FALLBACK_W, height: FALLBACK_H })
    expect(canvasSize(null)).toEqual({ width: FALLBACK_W, height: FALLBACK_H })
  })
})

describe('savedRectToPercent：解释 saved 的单位', () => {
  const saved = { left: 200, top: 100, width: 400, height: 300, zIndex: 1 }

  it("'%' 原样返回 —— 已经是新格式，不能再除一次画布", () => {
    expect(savedRectToPercent(saved, '%', 1000, 500)).toBe(saved)
  })

  it("'px' 走换算 —— 存量布局按像素理解", () => {
    const rect = savedRectToPercent(saved, 'px', 1000, 500)
    expect(rect.left).toBeCloseTo(20, 4)
    expect(rect.width).toBeCloseTo(40, 4)
  })
})

describe('snapRectToGrid：松手时把四条边收进网格', () => {
  // 横竖**各一个**步长 —— 这正是它比库自带 snapToGrid 强的地方（那边横竖共用一个）
  const STEP_X = 2.5
  const STEP_Y = 2

  it('left / width 吸到 STEP_X、top / height 吸到 STEP_Y，zIndex 原样', () => {
    const rect = snapRectToGrid({ left: 11.4337, top: 7.2, width: 33.3, height: 40.1, zIndex: 5 }, STEP_X, STEP_Y)
    expect(rect.left).toBe(12.5)
    expect(rect.top).toBe(8)
    expect(rect.width).toBe(32.5)
    expect(rect.height).toBe(40)
    expect(rect.zIndex).toBe(5)
  })

  it('宽高进网格是重点：右边/下边压不在线上，等于没对齐', () => {
    const rect = snapRectToGrid({ left: 10, top: 20, width: 33.3, height: 40.1 }, STEP_X, STEP_Y)
    const right = Number(rect.left) + Number(rect.width)
    const bottom = Number(rect.top) + Number(rect.height)
    expect(right).toBeCloseTo(10 + 32.5, 6)
    expect(bottom).toBeCloseTo(20 + 40, 6)
    // 收完的边仍然落在各自轴的网格线上
    expect(Number(right.toFixed(4)) % STEP_X).toBe(0)
    expect(Number(bottom.toFixed(4)) % STEP_Y).toBe(0)
  })

  it('位置收完不许把右边/下边顶出画布（left 最多 100 - width）', () => {
    const rect = snapRectToGrid({ left: 99, top: 99, width: 40, height: 40 }, STEP_X, STEP_Y)
    expect(rect.width).toBe(40)
    expect(rect.left).toBe(60)
    expect(rect.height).toBe(40)
    expect(rect.top).toBe(60)
    expect(Number(rect.left) + Number(rect.width)).toBeLessThanOrEqual(100)
  })

  it('拖到比一格还小的盒子撑回一格 —— 收成 0 就再也选不中了', () => {
    const rect = snapRectToGrid({ left: 0, top: 0, width: 0.4, height: 0.1 }, STEP_X, STEP_Y)
    expect(rect.width).toBe(STEP_X)
    expect(rect.height).toBe(STEP_Y)
  })

  it('字符串值（MovableBoxRect 允许 "12%"）按数字读', () => {
    const rect = snapRectToGrid({ left: '12%', top: '7.1%', width: '33.3', height: '40' }, STEP_X, STEP_Y)
    expect(rect.left).toBe(12.5)
    expect(rect.top).toBe(8)
    expect(rect.width).toBe(32.5)
    expect(rect.height).toBe(40)
  })

  it('步长配错（0 / 负数 / NaN）时原样返回 —— 吸附失败不能把布局弄坏', () => {
    const rect = { left: 11.4, top: 7.2, width: 33.3, height: 40.1 }
    expect(snapRectToGrid(rect, 0, STEP_Y)).toBe(rect)
    expect(snapRectToGrid(rect, STEP_X, Number.NaN)).toBe(rect)
    expect(snapRectToGrid(rect, -1, STEP_Y)).toBe(rect)
  })

  it('真实网格：1600×900 上的 20px 格子 = 横 1.25%、竖 2.2222%，两轴各算各的', () => {
    const rect = snapRectToGrid({ left: 1.4, top: 2.2, width: 33.31, height: 40.4, zIndex: 2 }, 100 / 80, 100 / 45)
    expect(rect.left).toBe(1.25) // 1.4 ÷ 1.25 = 1.12 → 第 1 格
    expect(rect.top).toBe(2.2222) // 2.2 ÷ 2.2222 = 0.99 → 第 1 格（竖轴用的是自己的刻度）
    expect(rect.width).toBe(33.75) // 33.31 ÷ 1.25 = 26.6 → 第 27 格
    expect(rect.height).toBe(40) // 40.4 ÷ 2.2222 = 18.18 → 第 18 格
    expect(rect.zIndex).toBe(2)
  })
})
