/**
 * 极简 semver 比较（P2）—— 只为 `plugin.json` 的 `coreCompatibility` 服务。
 *
 * ## 为什么不引 semver 包
 *
 * 我们只需要三件事：`a < b`、`a >= min`、`a <= max`。为一个比较器拉一个依赖，
 * 换来的是：插件作者的 `node_modules` 里多一个运行时依赖（哪怕只是构建期），
 * 以及「semver 的 range 语法我们到底支持到哪」这个新问题。
 *
 * 而且这里**故意不支持 range 表达式**（`^1.2.3` / `1.x` / `>=1 <2`）：
 * 支持一半的语法比不支持更糟 —— 插件作者会写出「我以为支持」的声明，
 * 然后在别的 Core 版本上被静默放行。`{ min, max }` 两个端点已经能表达
 * 「我需要 ≥3.1 且 <4.0」，且**两端的意思永远不含糊**。
 *
 * ## 范围之外怎么办
 *
 * **fail closed**：非法版本 / 非法约束一律判定为「不满足」。这条很重要 ——
 * 一个写错的 `min: "v3.1"`（多了个 v）如果被当成「无约束」，插件就在错误的 Core 上
 * 装上了，而症状是运行期的怪问题，不是启动时的一句提示。
 */

/** `x.y.z`（可带预发布后缀 `-alpha.1` / `+build`）；不接受 `^` / `~` / `x` 等简写 */
const STRICT = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/

export interface SemVer {
  major: number
  minor: number
  patch: number
  /** 预发布标识；`''` = 正式版 */
  prerelease: string
}

/** 解析；不合规返回 null（**不抛** —— 调用方决定怎么处理，fail closed 在上层做） */
export function parseSemVer(value: unknown): SemVer | null {
  if (typeof value !== 'string') return null
  const m = STRICT.exec(value.trim())
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? '',
  }
}

/**
 * 比较：`-1 / 0 / 1`。
 *
 * **预发布版小于同号正式版**（semver 的核心规则）：`3.0.0-alpha < 3.0.0`。
 * 这一点有实际后果 —— Core 自己是 `0.1.0` 时，一个声明 `min: "0.1.0"` 的插件
 * 在 Core 变成 `0.1.0-alpha` 时**不满足**。那是对的：预发布就是不稳定。
 *
 * 两个预发布版之间按标识符逐段比较（数字段按数值，字符串段按字典序，
 * 数字段小于字符串段 —— 与 semver 规范一致）。
 */
export function compareSemVer(a: SemVer, b: SemVer): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === '') return 1
  if (b.prerelease === '') return -1
  const as = a.prerelease.split('.')
  const bs = b.prerelease.split('.')
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i]
    const y = bs[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
      continue
    }
    // 数字段小于字符串段
    if (xn) return -1
    if (yn) return 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** 闭区间约束（两端都可省） */
export interface VersionRange {
  /** 含 */
  min?: string
  /** 含 */
  max?: string
}

/**
 * 版本是否落在闭区间内。**约束缺失或非法一律 false（fail closed）**。
 *
 * `range` 为空（两个端点都没给）→ 视为**无约束**（true）——
 * 「插件不声明就都能跑」是缺省，schema 层已经保证了这一点。
 */
export function satisfiesRange(version: string, range: VersionRange | undefined): boolean {
  if (!range || (range.min === undefined && range.max === undefined)) return true
  const v = parseSemVer(version)
  if (!v) return false
  if (range.min !== undefined) {
    const min = parseSemVer(range.min)
    if (!min) return false
    if (compareSemVer(v, min) < 0) return false
  }
  if (range.max !== undefined) {
    const max = parseSemVer(range.max)
    if (!max) return false
    if (compareSemVer(v, max) > 0) return false
  }
  return true
}

/** 不满足时给出**人可读**的原因；**满足或无约束时返回空串**（调用方只看有没有话要说） */
export function describeRangeMismatch(version: string, range: VersionRange | undefined): string {
  if (!range || (range.min === undefined && range.max === undefined)) return ''
  if (satisfiesRange(version, range)) return ''
  if (parseSemVer(version) === null) return `无法解析 Core 版本 '${version}'`
  if (range.min !== undefined && parseSemVer(range.min) === null) {
    return `coreCompatibility.min 不是合法版本: '${range.min}'`
  }
  if (range.max !== undefined && parseSemVer(range.max) === null) {
    return `coreCompatibility.max 不是合法版本: '${range.max}'`
  }
  const want = [range.min !== undefined ? `>= ${range.min}` : null, range.max !== undefined ? `<= ${range.max}` : null]
    .filter(Boolean)
    .join(' 且 ')
  return `要求 Core ${want}，当前 ${version}`
}
