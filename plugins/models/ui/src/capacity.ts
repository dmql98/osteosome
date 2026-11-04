/**
 * 上下文窗口 / 最大输出这一对「容量」字段的读写。
 *
 * ## 为什么要一个解析器，而不是直接 `<input type="number">`
 *
 * 用户脑子里记的是 `128K`、`1M`，不是 `131072`。dsh 的设置-模型页也是这套记法
 * （见 `formatCapacity` / `parseCapacity`），照抄它有两个好处：
 * 两个产品的输入习惯一致，而且「存的是数字、显示的是短写」这件事只在一个地方实现。
 *
 * ## 语义
 *
 * - `parseCapacity('')` → `undefined`：**没填**（= 用上游默认），与「填了 0」是两件事；
 * - `parseCapacity('abc')` → `NaN`：**填错了**。调用方必须把 `NaN` 当「不提交」，
 *   而不是当 0 写进配置 —— 那会让一个本该继承的模型被钉成 0 token。
 * - K / M 是十进制（1000 / 1_000_000），与 dsh 一致；不做 1024 进制，
 *   因为模型厂商的上下文窗口是按十进制标的（128K = 128000）。
 */

const SCALE: Record<string, number> = { k: 1_000, m: 1_000_000 }

/** `128K` / `1m` / `128000` / `0.5M` 都认；前后空白忽略 */
const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)\s*([km])?$/i

/**
 * 把用户写的容量读成 token 数。
 * @param text 输入框里的原文
 * @returns token 数；空串 → `undefined`（没填）；读不懂 → `NaN`（填错了）
 */
export function parseCapacity(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  const match = CAPACITY_PATTERN.exec(trimmed)
  if (match === null) return Number.NaN
  const scale = SCALE[(match[2] ?? '').toLowerCase()] ?? 1
  const scaled = Number(match[1]) * scale
  // 十进制倍数在二进制浮点里不精确（2.3 * 1e6 会偏几个 ULP），整数意图要吸附回来
  const rounded = Math.round(scaled)
  return Math.abs(scaled - rounded) < 1e-6 ? rounded : scaled
}

/**
 * 把 token 数写回最短的可往返形式。
 *
 * 只有整数倍才用 K/M —— `131072` 保持原样，否则 `131072 / 1000` 会写成 `131.072K`，
 * 来回一次就变形了。
 */
export function formatCapacity(value: number): string {
  if (!Number.isInteger(value) || value <= 0) return String(value)
  if (value % SCALE.m === 0) return `${value / SCALE.m}M`
  if (value % SCALE.k === 0) return `${value / SCALE.k}K`
  return String(value)
}
