/**
 * 皮肤契约 —— `userData/plugin/skins/skins.json` 的类型与校验器（只增不改）。
 *
 * ## 资产是**用户数据**，不是插件自带数据
 *
 * `userData/plugin/skins/` **存在**，由 `skin` 服务独占读写：
 * ```
 * userData/plugin/skins/
 * ├── skins.json          ← 清单（owner: skin 服务）
 * └── <skinId>/
 *     ├── portrait.png
 *     ├── avatar.png
 *     └── idle.webp / thinking.webp / …
 * ```
 * 界面因此**可写**：上传 / 裁剪 / 删除 / 改元数据都有落点。
 *
 * ## 判据：这是用户的决定
 *
 * 「我想让这个角色长什么样」是**用户的选择**，不是产品的一部分 ——
 * 与 `tools/approvals.json`（用户的授权决定）、`models/preferences.json`（用户的接入决定）
 * 同一类。所以它进 `userData`，并在**卸载插件时保留**（照 `approvals.json` 的先例：
 * 数据保留、只是不再可用，重装即恢复）。
 *
 * 代价是明摆着的，且都要写进界面：
 * - **卸载不删数据** → 重装即恢复用户的皮肤，但要回答「旧资产还在，占着磁盘」
 * - **要回答两个真源的冲突**：`skins.json` 是数据，但插件**升级**会带来新的内置皮肤。
 *   见 {@link mergeCatalog} —— 合并规则必须显式，不能靠「谁后写谁赢」
 * - **资产路径存在运行期可被改动的东西** → 穿越校验从「构建期一次性」变成
 *   **每次写都验**，见 {@link assertSafeAssetPath}
 *
 * ## 路径校验为什么必须在这一层做两道
 *
 * ① 这里（写入时 fail fast，坏路径当场报错并记进 `errors`）
 * ② Core 的新路由 `GET /plugins/<id>/data/*`（读取时的穿越检查）
 *
 * 两道闸，不是两道重复。① 的价值是<b>用户当场看到「这个路径不合法」</b>，
 * 而不是过五分钟某个视图的 `<img>` 拿到一个 403 —— 那时候用户已经不知道
 * 刚才那一步是哪一步了。这与工具侧「约束 + 审批」是同一条纪律。
 */
import { isValidPluginId } from './paths'

/**
 * 六个动作。**刻意收窄到 6 个**，照抄天枢 `SkinVisualEditor` 暴露的那 6 个。
 *
 * 天枢的 motion *枚举*其实有 16 个（`blink / breathe / listening / toolCalling /
 * happy / touched / wave / walk / jump / sleep`…），但编辑器只给 6 个。本文取 6 个，
 * 因为**渲染侧要能自己决定播哪个**：一个只有 `idle` 与否的渲染器遇到 `blink`
 * 就必须回退，而回退策略又是一笔界面复杂度。
 *
 * 少而够用 > 多而半吊子。`skins.json` 里出现这 6 个之外的名字是**合法但不被引用**的
 * （`parseSkinCatalog` 不报错，界面上标「未被使用」）。
 *
 * ⚠️ 这份枚举与 `../chat-workbench/对话工作台-会话列表重设计.html` 的
 * `--motion-idle / --motion-thinking / …` 是**同一批运行态**，所以两边都 import 这一份
 * （枚举共享是对的：同一批状态）。但**CSS 变量名不共享** ——
 * 那份用颜色表示（会话行左端的一小条），本设计用图片表示（舞台上的一帧）。
 * 皮肤侧一律 `--skin-motion-*`，且不进 `sdk/ui/src/tokens.css`（那是组件库真值，
 * 而这是某个具体视图的状态色）。撞名会让「调个色」变成「换张图」。
 */
export const MOTIONS = ['idle', 'thinking', 'working', 'speaking', 'success', 'error'] as const

/** 动作名（与 {@link MOTIONS} 同源，供界面做穷尽式渲染） */
export type Motion = (typeof MOTIONS)[number]

/** `true` 当 `x` 是六个动作之一 */
export function isMotion(x: unknown): x is Motion {
  return typeof x === 'string' && (MOTIONS as readonly string[]).includes(x)
}

/**
 * 静态资产可用的扩展名。
 *
 * **不包含 mp4 / webm** —— Core 的 `contentTypeFor` MIME 表里没有它们，会回落成
 * `application/octet-stream`，`<video>` 放不出来。而**动画 webp / gif 在 `<img>` 里就能播**，
 * 尺寸控制也完全一样，所以这里只列 MIME 表里已经有的那几个。
 * 要 mp4 的话是给 `util.ts` 的 MIME 表加两个表项（纯增量），那是另一件事。
 */
export const SKIN_ASSET_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] as const

/** 资产类型（`portrait` / `avatar`） */
export type SkinAssetKind = 'portrait' | 'avatar'

/**
 * 一条资产记录（存在 `skins.json` 里，**不**指向目录）。
 *
 * ## 为什么存「记录」而不是「路径」
 *
 * 早期形态是 `portrait: "assets/miku/portrait.png"` —— 一个手写的相对路径。
 * 走用户数据路线之后那个做法有两个问题：
 * 1. **改名 = 改 JSON**：用户在界面上换一张图，服务得去改 `skins.json` 的字符串；
 *    而 JSON 是被别的逻辑读写的，两处改同一个文件容易撞
 * 2. **缓存没法失效**：文件被替换但名字没变，浏览器继续用缓存里的旧图
 *
 * 所以存三件事：**文件 id**（内容寻址）、**字节数**（配额与前端预检）、**mtime**（变更检测）。
 * 真实路径由服务按 `assets/<assetId>.<ext>` 拼出来 —— **不进数据文件**，
 * 于是「路径规则」只有服务一处知道。
 */
export interface SkinAsset {
  /** 内容寻址的文件 id（`assets/<assetId>.<ext>`；路径规则由服务掌握，不进本文件） */
  assetId: string
  /** 字节数。用于配额与上传前预检，不做信任校验 */
  bytes: number
  /** 修改时间 ms（epoch）。用于界面上的「这套皮肤什么时候改的」与变更检测 */
  mtime: number
  /** 扩展名（不含点），取值见 {@link SKIN_ASSET_EXTENSIONS} */
  ext: string
}

/**
 * `skin.set` 的 patch —— **合并式**，没给的键不变。
 *
 * ## 三种操作，三种形状
 *
 * 之所以不设计成「一条命令三种形态」，是因为它们的**失败模式完全不同**，
 * 混在一个 patch 里调用方就得自己判断哪个字段组合合法：
 * | 操作 | 形状 | 典型失败 |
 * |---|---|---|
 * | 改元数据 | `id` + `patch{name?,license?,builtin?}` | id 不存在 |
 * | 删除 | `id` + `removed:true` | **被角色引用中** |
 * | 停用 | `id` + `enabled:false` | 同上 |
 *
 * `removed` 与 `enabled:false` 分开而不是合成一个 `enabled` ——
 * 前者会**连资产目录一起删**（不可逆），后者只让渲染侧不看它（随时能开回来）。
 * 把它们并成一个布尔，用户按错一次就永久丢图。
 */
export interface SkinSetPatch {
  /** 目标皮肤 id */
  id: string
  /** 改显示名 */
  name?: string
  /** 改许可标识 */
  license?: string
  /** 停用：渲染侧不再用它，资产保留。缺省 `true`，写 `false` 等于启用 */
  enabled?: boolean
  /** 删除：连同资产目录一起删，不可逆 */
  removed?: boolean
  /**
   * 「没有角色在用」这个前提。
   *
   * **必填于 `removed`**：服务会拿 `agent.state` 里活着的角色核对，发现有引用就拒绝。
   * 之所以要用户点两次而不是服务自己判断 —— 因为 `agent.state` 可能没到
   * （agents 服务刚起、或已被卸载），那时候服务**无法确认**有没有人在用，
   * 而「我确认没人用」是用户比服务更有资格说的话。
   */
  confirmUnreferenced?: boolean
}

/**
 * `skin.set` 的结果（走 `<cmd>.result`，与其它命令同构）。
 */
export interface SkinSetResult {
  requestId: string
  ok: boolean
  /** 这次改动实际影响了哪几套皮肤（用于事件流里显示） */
  changed?: string[]
  /**
   * 因「被角色引用中」而被拒绝的引用者。
   *
   * ⚠️ **尽力而为**：数据来自 `agent.state`，那份没到时这里是空的。
   * 所以「空」有两个含义（真的没人用 / 不知道有没有人用），界面上不能把它
   * 当成「确认无人引用」的证明。
   */
  blockedBy?: string[]
  /** 被拒绝的原因（中文直接可展示，或让界面按 code 翻） */
  reason?: string
}

/**
 * `skins.json` 里**字面写着**的一条（未规范化）。
 *
 * ## 为什么与 {@link SkinBrief} 分成两个类型
 *
 * 输入比输出**宽**，差别有几处，每一处都是一条规范化承诺：
 * | 字段 | 写的时候 | {@link SkinBrief} |
 * |---|---|---|
 * | `assets` | 可整个省掉 | 恒为对象（省掉 → `{}`） |
 * | `builtin` | 可省掉 | 恒为 boolean（省掉 → `true`） |
 * | `motions` | 键可以是**任意字符串** | 只保留 {@link MOTIONS} 里的六个 |
 *
 * 最后一条是刻意的：六个之外的名字**合法但不被引用**，所以它既不该在类型上报错
 * （那是合法的输入），也不该出现在规范化后的结果里（没人会去渲染它）。
 * 这就是「输入宽、输出窄」的具体含义 —— 把两者混成一个类型，
 * 就得在类型上放宽输出，或者在类型上禁止合法的输入。
 */
export interface SkinEntry {
  id: string
  name: string
  builtin?: boolean
  /**
   * 停用标记：写 `false` = 渲染侧不再用它，**资产保留**（可逆）。
   *
   * 缺省视为 `true`。与 `removed`（删除，连资产一起删，不可逆）分开两件事 ——
   * 并成一个布尔的话，用户按错一次就永久丢图。见 {@link SkinSetPatch}。
   */
  enabled?: boolean
  assets?: Partial<Record<SkinAssetKind, SkinAsset>>
  motions?: Record<string, SkinAsset>
  license?: string
  /** 提供方插件 id；多插件共存时用来标来源 */
  providedBy?: string
  /** 首次写入时间 ms（epoch）—— 「这套皮肤是什么时候建的」 */
  createdAt?: number
  /** 最近一次修改时间 ms（epoch） */
  updatedAt?: number
}

/** `skins.json` 的顶层形状 */
export interface SkinCatalog {
  /** 清单格式版本；将来加字段时递增，旧 reader 按 `>= 1` 读 */
  version: number
  skins: SkinEntry[]
}

/** 一套皮肤（`skins.json` 的一条，也是 `skin.state` 载荷的一条） */
export interface SkinBrief {
  /** 全局唯一；角色档案的 `skinId` 引用的就是它。**缺失即悬空引用** */
  id: string
  /** 人类可读名 */
  name: string
  /**
   * 内置 vs 用户自建。
   *
   * **界面上必须能区分**：内置皮随插件升级而更新，用户皮只属于这个用户。
   * 两者的删除语义完全不同（内置皮不能删，只能停用）。
   */
  builtin: boolean
  /**
   * 是否启用。**恒为 boolean**（缺省 → `true`）。
   *
   * 停用是**可逆**的：资产还在，只是渲染侧不再选它。
   * 与「删除」（`skin.set{removed:true}`，连目录一起删）是两件事 ——
   * 界面上要把它们分成两处，并成一个布尔，用户按错一次就永久丢图。
   *
   * ⚠️ **停用不改任何角色的 `skinId`**：引用仍然指向它，
   * 于是角色侧会显示成「绑着但不可用」，而不是「悬空」。
   * 恢复动作是「启用」，不是「解绑」。
   */
  enabled: boolean
  /** 静态资产。**可以缺** —— 一套只有动作、没有立绘的皮肤是合法的 */
  assets: Partial<Record<SkinAssetKind, SkinAsset>>
  /**
   * 动作 → 资产。**可以为空**（一套静态皮肤也是合法的皮肤）。
   *
   * 键是 {@link MOTIONS} 里的名字。
   */
  motions: Partial<Record<Motion, SkinAsset>>
  /**
   * 许可标识（SPDX 表达式）。**缺失时界面要显示警示，而不是默认当 MIT** ——
   * 默认当 MIT 是把法律责任转给了用户。
   */
  license?: string
  /** 提供方插件 id */
  providedBy?: string
  /** 首次写入时间 ms */
  createdAt?: number
  /** 最近一次修改时间 ms */
  updatedAt?: number
}

/**
 * 路径安全判定（写入时的第一道闸）。
 *
 * 规则只有三条，但每条都有具体的攻击形态：
 * - **不得为空** —— 空路径会被 `path.resolve(root, '')` 解析成 root 本身
 * - **不得绝对**（`/foo` 或 `C:\foo`）—— 绝对路径会让 `resolve` 丢掉 root，
 *   后面那道 `startsWith` 检查就形同虚设
 * - **不得含 `..` 段** —— 反斜杠先归一，所以 `..\..` 与 `../..` 都被覆盖
 *
 * 允许 `./a.webp` 与 `a/b.webp`：相对的多级目录是合法的（用户分文件夹放图）。
 */
export function assertSafeAssetPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.trim() === '') return false
  if (p.includes('\0')) return false
  // 绝对路径：posix 的 `/` 与 Windows 的盘符 / UNC
  if (p.startsWith('/') || p.startsWith('\\')) return false
  if (/^[a-zA-Z]:[\\/]/.test(p)) return false
  const norm = p.replace(/\\/g, '/')
  if (norm.split('/').some((seg) => seg === '..')) return false
  return true
}

/** 文件 id 的合法性：十六进制或 base36 短串，不含路径分隔符 */
export function assertSafeAssetId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id)
}

/** 皮肤 id 的合法性：比工具名宽（用户起的名字），但不许碰路径与分隔符 */
export function assertSafeSkinId(id: unknown): id is string {
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) return false
  if (id.includes('\0')) return false
  // skinId 会变成一个**目录名**（`userData/plugin/skins/<skinId>/`），所以连普通的
  // 分隔符都不能有 —— 不只是 `..`。这一条比 `assertSafeAssetPath` 更严，
  // 因为那里的输入是**文件名的一部分**，而这里是整个目录名。
  if (id.includes('/') || id.includes('\\')) return false
  if (id === '.' || id === '..') return false
  // 盘符与 UNC 前缀
  if (p_isDriveLike(id)) return false
  // 尾部的点与空格在 Windows 上会被静默剥掉（`foo.` 与 `foo` 是同一个目录），
  // 那会让两个不同的 id 指向同一个目录 —— 用户会看到「新建了却覆盖了别的」。
  if (/[. ]$/.test(id)) return false
  return true
}

/** Windows 盘符（`C:`）或 UNC 前缀（`\\host`） */
function p_isDriveLike(s: string): boolean {
  return /^[a-zA-Z]:/.test(s) || s.startsWith('\\\\')
}

/**
 * 校验一条资产记录。
 *
 * `bytes` / `mtime` **只做类型与范围检查，不做信任校验** ——
 * `bytes` 的真值由服务读文件时 `stat` 得到，这里那个字段是**上传真值**，
 * 作用只是配额预检与前端展示。用它当「这个文件有多大」的真相会漏。
 */
function parseAsset(where: string, raw: unknown, errors: string[]): SkinAsset | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${where} is not an object`)
    return null
  }
  const a = raw as Record<string, unknown>
  if (!assertSafeAssetId(a.assetId)) {
    errors.push(`${where}: assetId must be 8-64 chars of [A-Za-z0-9_-] (${JSON.stringify(a.assetId)})`)
    return null
  }
  if (!(SKIN_ASSET_EXTENSIONS as readonly string[]).includes(String(a.ext))) {
    errors.push(`${where}: ext must be one of ${SKIN_ASSET_EXTENSIONS.join('/')} (${JSON.stringify(a.ext)})`)
    return null
  }
  if (typeof a.bytes !== 'number' || !Number.isFinite(a.bytes) || a.bytes < 0) {
    errors.push(`${where}: bytes must be a non-negative finite number`)
    return null
  }
  if (typeof a.mtime !== 'number' || !Number.isFinite(a.mtime) || a.mtime < 0) {
    errors.push(`${where}: mtime must be a non-negative finite number`)
    return null
  }
  return {
    assetId: a.assetId,
    bytes: a.bytes,
    mtime: a.mtime,
    ext: String(a.ext),
  }
}

/**
 * 解析并校验 `skins.json`。
 *
 * ## 返回 `{ skins, errors }` 而不是抛
 *
 * 与 `parseVendorCatalog` 同一个理由：**逐条报，不整份拒**。
 * 一套皮肤的字段写错不该让其余皮肤一起消失；而调用方（服务）需要能
 * **照常启动**并把错误打进日志 —— 界面上少一套皮肤比整个视图起不来好。
 *
 * ## 拒绝的是「会被当成别的文件」，不是「不好看」
 *
 * `assetId` 会被服务拼成 `assets/<assetId>.<ext>` 落盘、再被 Core 的路由读出去。
 * 一个带 `../` 的 `assetId` 就会写到插件数据目录之外，所以这里必须拒
 * （第二道闸在 Core 的路由侧）。许可缺失、内置皮没写 `builtin` 都不是错。
 */
export function parseSkinCatalog(raw: unknown): { skins: SkinBrief[]; errors: string[] } {
  const errors: string[] = []
  const skins: SkinBrief[] = []

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { skins, errors: ['catalog is not an object'] }
  }
  const obj = raw as Record<string, unknown>
  if (obj.version !== 1) {
    // 版本不认识就整份拒：跨版本的字段语义可能变了，逐条猜比停下安全
    return { skins, errors: [`catalog.version must be 1 (got ${JSON.stringify(obj.version)})`] }
  }
  if (!Array.isArray(obj.skins)) {
    return { skins, errors: ['catalog.skins is not an array'] }
  }

  const seen = new Set<string>()
  obj.skins.forEach((item, index) => {
    const at = `skins[${index}]`
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${at} is not an object`)
      return
    }
    const s = item as Record<string, unknown>
    const bad = (why: string): void => {
      errors.push(`${at} (${String(s.id ?? '?')}): ${why}`)
    }

    for (const key of ['id', 'name'] as const) {
      if (typeof s[key] !== 'string') {
        bad(`${key} must be a string`)
        return
      }
    }
    if (!assertSafeSkinId(s.id)) {
      bad(`id must be 1-64 chars and must not contain path separators (${JSON.stringify(s.id)})`)
      return
    }
    // `builtin` 缺省视为 true：迁移期的旧清单里没有这个字段，
    // 而那批皮肤**都是**内置的。反过来不成立 —— 内置皮显式写 `builtin:false`
    // 是有意义的（用户可换掉它）。
    if (s.builtin !== undefined && typeof s.builtin !== 'boolean') {
      bad('builtin must be a boolean when present')
      return
    }
    if (s.enabled !== undefined && typeof s.enabled !== 'boolean') {
      bad('enabled must be a boolean when present')
      return
    }
    if (seen.has(s.id as string)) {
      // 重复 id 会被后面的静默覆盖 —— 用户会看到「设了没生效」。
      // 与 `parseVendorCatalog` 同一处置：报错并**跳过后者**，保留先到的那条。
      bad('duplicate skin id')
      return
    }

    // ── assets ──
    const assets: SkinBrief['assets'] = {}
    if (s.assets !== undefined) {
      if (!s.assets || typeof s.assets !== 'object' || Array.isArray(s.assets)) {
        bad('assets must be an object when present')
        return
      }
      const a = s.assets as Record<string, unknown>
      for (const key of ['portrait', 'avatar'] as const) {
        if (a[key] === undefined) continue
        const parsed = parseAsset(`${at} (${String(s.id)}).assets.${key}`, a[key], errors)
        if (!parsed) return
        assets[key] = parsed
      }
    }

    // ── motions ──
    const motions: SkinBrief['motions'] = {}
    if (s.motions !== undefined) {
      if (!s.motions || typeof s.motions !== 'object' || Array.isArray(s.motions)) {
        bad('motions must be an object when present')
        return
      }
      const m = s.motions as Record<string, unknown>
      for (const key of Object.keys(m)) {
        // 六个之外的名字**合法但不被引用** —— 不报错，界面标「未被使用」。
        // 但它们的**值**仍然要校验：记录会被拼成路径落盘。
        const parsed = parseAsset(`${at} (${String(s.id)}).motions.${key}`, m[key], errors)
        if (!parsed) return
        if (isMotion(key)) motions[key] = parsed
      }
    }

    if (s.license !== undefined && typeof s.license !== 'string') {
      bad('license must be a string when present')
      return
    }
    if (s.providedBy !== undefined && typeof s.providedBy !== 'string') {
      bad('providedBy must be a string when present')
      return
    }
    for (const key of ['createdAt', 'updatedAt'] as const) {
      if (s[key] !== undefined && (typeof s[key] !== 'number' || !Number.isFinite(s[key]))) {
        bad(`${key} must be a finite number when present`)
        return
      }
    }

    seen.add(s.id as string)
    skins.push({
      id: s.id as string,
      name: s.name as string,
      builtin: s.builtin === undefined ? true : (s.builtin as boolean),
      // `enabled` 缺省 → true：迁移期旧清单没有这个字段，而那批都是启用的。
      enabled: s.enabled === undefined ? true : (s.enabled as boolean),
      assets,
      motions,
      ...(typeof s.license === 'string' ? { license: s.license } : {}),
      ...(typeof s.providedBy === 'string' ? { providedBy: s.providedBy } : {}),
      ...(typeof s.createdAt === 'number' ? { createdAt: s.createdAt } : {}),
      ...(typeof s.updatedAt === 'number' ? { updatedAt: s.updatedAt } : {}),
    })
  })

  return { skins, errors }
}

/**
 * 目录排序：**内置在前，再按 name**。
 *
 * 内置皮肤是默认值，用户最常需要它。
 *
 * ⚠️ **不要按「最近更新」排** —— 同一时刻换一张图会重排整个列表，
 * 用户点着的那一行会跳走。`updatedAt` 可以显示，但**不作为排序键**。
 */
export function sortSkins(skins: readonly SkinBrief[]): SkinBrief[] {
  return [...skins].sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
}

/** 这套皮肤声明了但**未被引用**的动作名（`skins.json` 里出现六个之外的键） */
export function unusedMotionKeys(motions: Record<string, unknown>): string[] {
  return Object.keys(motions).filter((k) => !isMotion(k)).sort()
}

/**
 * 这套皮肤**实际可用**的动作（六个里它声明了的那些）。
 *
 * 界面上「几格是绿的 / 几格是灰的」由它决定 —— 缺失的那几格**也要画出来**（虚线框），
 * 因为隐藏缺失会让用户以为这套皮肤只有这些动作，而回退是在会话里撞见的、
 * 且是静默的（`SkinRenderer` 第 1 级）。
 */
export function availableMotions(skin: SkinBrief): Motion[] {
  return MOTIONS.filter((m) => typeof skin.motions[m] === 'object')
}

/** 缺失的动作名（六个里它没声明的那些），供界面逐个列出 */
export function missingMotions(skin: SkinBrief): Motion[] {
  return MOTIONS.filter((m) => typeof skin.motions[m] !== 'object')
}

/** 这套皮肤占用的字节数（静态资产 + 动作资产）。配额提示用 */
export function skinBytes(skin: SkinBrief): number {
  let n = 0
  for (const a of Object.values(skin.assets)) n += a.bytes
  for (const a of Object.values(skin.motions)) n += a.bytes
  return n
}

/**
 * **清单合并的唯一规则** —— 内置皮肤随插件升级而来，用户皮只属于这个用户。
 *
 * ## 为什么必须有这条，而不是「谁后写谁赢」
 *
 * 走用户数据之后，数据文件里同时住着两类东西：
 * - **用户自建**的（`builtin: false`）—— 只有用户能改能删
 * - **插件升级带进来的**内置皮（`builtin: true`）—— 版本一变就可能增删改
 *
 * 而 `skins.json` 是**持久**的：装一次插件、之后每次启动都读它。于是插件从 1.2 升到 1.3
 * 带了新内置皮时，如果不做合并，那个新皮**永远不会出现**（用户文件里没有它），
 * 反过来某个被上游删掉的内置皮会**永远赖着不走**（用户文件里还有它）。
 *
 * ## 规则（三条，各自对应上面那个方向的问题）
 *
 * 1. **内置皮以代码为准**：`fresh` 里的内置皮**覆盖** `persisted` 里的同名条目。
 *    用户改过内置皮的显示名也会被覆盖 —— 这是有意的：内置皮是产品的，
 *    它随版本变化，用户对它没有所有权。<b>想让名字保持自己的，就 fork 一份。</b>
 * 2. **用户皮以数据为准**：`persisted` 里的 `builtin: false` 条目全部保留，
 *    同名时 `fresh` 覆盖不进去（用户皮与内置皮同名 = 用户皮的 id 冲突，拒）
 * 3. **孤儿内置皮要留痕**：内置皮从版本里消失时，不静默丢，留一条
 *    `orphanedBuiltin` —— 界面上显示成「已从插件中移除（数据保留）」，
 *    <b>并给一个删除按钮</b>。静默丢会删掉用户可能改过的东西</p>
 *
 * 每次合并的**变更项**都作为返回值，好让服务只重播差异而不是整份。
 */
export function mergeCatalog(
  persisted: { skins: SkinEntry[] },
  fresh: { skins: SkinEntry[] },
): { skins: SkinEntry[]; changed: boolean; orphanedBuiltin: string[] } {
  const byId = new Map<string, SkinEntry>()
  for (const e of persisted.skins ?? []) byId.set(e.id, e)

  // 「内置」= `builtin !== false`。用 `!== false` 而不是 `=== true` 是因为迁移期的
  // 旧条目没有这个字段，而那批都是内置的。
  //
  // **第 2 条（用户皮以数据为准）在这里生效**：persisted 里标着 `builtin: false`
  // 的条目即使用户皮，fresh 无权覆盖 —— 否则插件升级就会改掉用户自己的皮。
  // 所以先记下哪些 id 被用户占了，再让 fresh 只覆盖没被占的那些。
  const userOwned = new Set<string>()
  for (const e of persisted.skins ?? []) {
    if (e.builtin === false) userOwned.add(e.id)
  }

  const freshBuiltin = new Map<string, SkinEntry>()
  for (const e of fresh.skins ?? []) {
    if (e.builtin === false) continue
    if (userOwned.has(e.id)) continue
    freshBuiltin.set(e.id, e)
  }

  // 1. 内置皮以 fresh 为准（覆盖 persisted 里的同名内置条目）
  for (const [id, e] of freshBuiltin) byId.set(id, e)

  // 2. 孤儿内置皮：persisted 里有、fresh 里没有、且它标了 builtin。
  //    「标了 builtin」= `builtin !== false`，因为迁移期的旧条目没这个字段，
  //    而那批都是内置的（用户皮从一开始就会显式写 `builtin:false`）。
  const orphanedBuiltin: string[] = []
  for (const [id, e] of byId) {
    if (!freshBuiltin.has(id) && e.builtin !== false) orphanedBuiltin.push(id)
  }

  const out: SkinEntry[] = [...byId.values()]
  sortEntries(out)
  // `changed` 要比的是**同序**的两份，否则「只是顺序不同」会被误判成变更 ——
  // 而重播整份对一次纯重排是纯浪费。persisted 的顺序是上一次我们自己排的，
  // 所以拿排好序的它来比。
  const prev = [...(persisted.skins ?? [])]
  sortEntries(prev)
  return { skins: out, changed: !sameEntryList(out, prev), orphanedBuiltin }
}

/**
 * 内置在前、再按 name —— 与 {@link sortSkins} 同一条规则。
 *
 * 排序规则住在**两个地方**（这里与 `sortSkins`）看起来像重复，但它不是：
 * `sortSkins` 排的是「给界面看的那一份」，这里排的是「要落盘的那一份」，
 * 落盘那份也必须有确定顺序 —— 否则同一个内容两次启动写出两个字节序不同的文件，
 * `changed` 会永远为 true。
 * 名字都是中文时按码位比（`默` U+9ED8 > `霓` U+9713），所以「霓虹」排在「默认」前面 ——
 * 这不是 bug，只是中文按码位排序的必然结果；界面上要按语言习惯排的话得另给
 * `localeCompare`，那是**界面**的事，不影响落盘顺序的确定性。
 */
function sortEntries(list: SkinEntry[]): void {
  list.sort((a, b) => {
    const ab = a.builtin !== false
    const bb = b.builtin !== false
    if (ab !== bb) return ab ? -1 : 1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
}

function sameEntryList(a: readonly SkinEntry[], b: readonly SkinEntry[]): boolean {
  if (a.length !== b.length) return false
  return a.every((x, i) => JSON.stringify(x) === JSON.stringify(b[i]))
}

/** 插件数据目录里皮肤的子目录名规则 —— **只有这一处**知道路径怎么拼 */
export function skinAssetFileName(asset: SkinAsset): string {
  return `assets/${asset.assetId}.${asset.ext}`
}

/** 这条能力需要 pluginId 合法；导出以便调用方在写命令前先验一次 */
export { isValidPluginId }
