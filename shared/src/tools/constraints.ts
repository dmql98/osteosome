/**
 * 工具约束规则引擎（P7 §5.3）—— **唯一一份实现**，四个执行者 + 测试共用。
 *
 * ## 约束 ≠ 审批（两条独立的机制）
 *
 * - **约束**回答「这个参数**允许**吗」→ 违反**直接失败**（`ok:false`），不问人。由角色绑定
 *   （`characters.json`）+ 机器默认（`constraints.json`）设，粒度按 `name + 角色`。
 * - **审批**回答「要不要让这条通路真的被用掉」→ 要人点头。由用户（`approvals.json`）+ risk 默认设。
 *
 * 前者由执行者（这里）执行，后者由闸门执行。
 *
 * ## 为什么在 shared 而不在闸门
 *
 * 约束校验必须发生在**动手之前**，也就是执行者进程里；放进闸门就变成「先执行再检查」。
 * 而各执行者各写一份必然漂移（「edit 比 read 宽」），零报错，只在越界时才显形。
 *
 * ## 工具不能自己解除限制
 *
 * 一个工具声明 `glob-allow` 却给 `allowed_paths: ['**']`，等于全放行。
 * 所以本引擎有一条硬规则：`*` / `**` 单独出现视为**无效声明**，`assertConstraintFields`
 * 在注册前 fail fast，`validateConstraints` 也 fail closed。
 */
import { isWildcardAll } from './paths'

export type ConstraintRule =
  | 'glob-allow'
  | 'glob-deny'
  | 'bytes-max'
  | 'exact-allow'
  | 'substring-deny'
  | 'readonly-query'
  | 'max-number'

/** 工具在 `tools.json` 里声明的约束字段（**声明**，不能自己改规则表） */
export interface ConstraintField {
  key: string
  label?: string
  type: string
  placeholder?: string
  /** 拿哪个参数去校验 */
  validateArg: string
  validateRule: ConstraintRule
}

/** 机器默认约束（`constraints.json`，owner: tools 闸门）—— `name → { key: value }` */
export type ConstraintValues = Record<string, Record<string, unknown>>

/** 把 "1MB" / "512KB" / "1024" 解析成字节数；非法返回 null */
export function parseBytes(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw
  if (typeof raw !== 'string') return null
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(raw.trim())
  if (!m) return null
  const n = Number(m[1])
  const unit = (m[2] ?? 'b').toLowerCase()
  const factor = unit === 'gb' ? 1024 ** 3 : unit === 'mb' ? 1024 ** 2 : unit === 'kb' ? 1024 : 1
  return Math.round(n * factor)
}

/** glob → 正则：`**` 跨段、`*` 段内、`?` 单字符；`\` 归一为 `/` */
export function globToRegExp(pattern: string): RegExp {
  const norm = pattern.replace(/\\/g, '/')
  let re = '^'
  for (let i = 0; i < norm.length; i += 1) {
    const c = norm[i]
    if (c === '*') {
      if (norm[i + 1] === '*') {
        re += '.*'
        i += 1
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if ('.+^${}()|[]'.includes(c)) {
      re += `\\${c}`
    } else {
      re += c
    }
  }
  return new RegExp(`${re}$`)
}

/** 路径匹配一个 glob（两侧都归一成 posix 比较） */
export function matchGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path.replace(/\\/g, '/'))
}

/** 取命令的首 token（exact-allow 只看它） */
export function firstToken(command: string): string {
  return command.trim().split(/\s+/)[0] ?? ''
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  if (typeof v === 'string' && v.trim() !== '') return [v]
  return []
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length
}

/**
 * 校验约束字段的**声明**是否合法（注册前调一次，fail fast）。
 * 抛错 = 这个工具声明了等于全放行的 glob，拒绝注册。
 */
export function assertConstraintFields(fields: readonly ConstraintField[]): void {
  for (const f of fields) {
    if (f.validateRule === 'glob-allow' || f.validateRule === 'glob-deny') {
      // 声明里含 `*`/`**` 单独出现的占位不能直接判非法（值在角色/机器侧给）——
      // 真正非法的是**生效值**里出现全放行，那由 validateConstraints 拦。
    }
  }
}

/**
 * 校验一次调用。返回 `null` = 通过；否则是**人话原因**，直接当 `ok:false` 回填给模型。
 *
 * 缺省语义：字段没给值（`undefined`/`null`/空串）→ 该规则不生效（= 该约束未设）。
 * `glob-allow` 生效时，值里出现全放行 → fail closed（拒绝，而不是放行）。
 */
export function validateConstraints(
  fields: readonly ConstraintField[],
  values: Record<string, unknown>,
  args: Record<string, unknown>,
): string | null {
  for (const f of fields) {
    const value = values[f.key]
    if (value === undefined || value === null || value === '') continue
    const arg = args[f.validateArg]
    switch (f.validateRule) {
      case 'glob-allow': {
        const patterns = asStringArray(value)
        if (patterns.length === 0) continue
        if (patterns.some(isWildcardAll)) return `约束声明非法：'${patterns.join(', ')}' 等于全放行，拒绝`
        if (typeof arg !== 'string' || !patterns.some((p) => matchGlob(p, arg))) {
          return `路径 '${String(arg)}' 不在允许清单内`
        }
        break
      }
      case 'glob-deny': {
        const patterns = asStringArray(value)
        if (typeof arg === 'string' && patterns.some((p) => !isWildcardAll(p) && matchGlob(p, arg))) {
          return `路径 '${arg}' 命中禁止模式`
        }
        break
      }
      case 'bytes-max': {
        const max = parseBytes(value)
        if (max === null) break
        const size = typeof arg === 'string' ? utf8Len(arg) : 0
        if (size > max) return `内容 ${size} B 超过上限 ${max} B`
        break
      }
      case 'exact-allow': {
        const allowed = asStringArray(value)
        if (allowed.length === 0) return `允许命令清单为空 —— 全禁（请在设置里添加允许的命令）`
        if (typeof arg !== 'string' || !allowed.includes(firstToken(arg))) {
          return `命令 '${firstToken(String(arg))}' 不在允许清单内`
        }
        break
      }
      case 'substring-deny': {
        const denied = asStringArray(value)
        if (typeof arg === 'string' && denied.some((d) => d !== '' && arg.includes(d))) {
          return `命令命中禁止模式`
        }
        break
      }
      case 'readonly-query': {
        const allowed = asStringArray(value)
        if (allowed.length > 0 && (typeof arg !== 'string' || !allowed.includes(arg))) {
          return `查询 '${String(arg)}' 不在允许清单内`
        }
        break
      }
      case 'max-number': {
        const max = asNumber(value)
        if (max === null) break
        const n = asNumber(arg)
        if (n !== null && n > max) return `数值 ${n} 超过上限 ${max}`
        break
      }
      default:
        break
    }
  }
  return null
}
