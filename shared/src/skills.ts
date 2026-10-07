/**
 * 技能契约 —— SKILL.md 的解析与索引条目（只增不改）。
 *
 * ## 技能是什么
 *
 * 技能的事实来源是**磁盘上的目录**：`<name>/SKILL.md`（frontmatter + 正文）。
 * - **插件自带**：`plugins/<plugin>/skills/<name>/SKILL.md`，由**那个插件自己的服务**读完
 *   （`plugins.readFile` 只限自己插件目录）再 `publish skill.registered` 交上来。
 * - **用户自建**：`userData/plugin/skills/custom/<name>/SKILL.md`，**skills 服务是唯一写者**。
 *
 * ## 索引全系统一份
 *
 * skills 服务是**收集方**，汇总成 `skills.state`（name + description + 来源 + 启用态）。
 * 索引进提示词的部分只有 name + description（**一个片段 / p10**）；正文经 `skill_read`
 * 按需回吐（属 tools 插件 P7 的 `skills-tools` 执行者，本阶段不做）。
 *
 * ## 两个开关，合成是 AND
 *
 * 本机可用（`skills.json` 的机器级开关，本服务持有）∩ 角色绑定（`characters.json · skills[]`）。
 * **AND 必须在服务端成立**：索引里看得见的技能，模型一定读得到；否则会出现
 * 「索引里看见了、去读被拒、原因用户看不到」。做法是 `skills.list{characterId}` ——
 * loop 先 `agent.resolve` 拿到角色，再按角色要清单（skills 服务仍是唯一持有目录的人）。
 */
export const SKILL_INDEX_BUDGET_BYTES = 8 * 1024
export const SKILL_INDEX_MAX_ENTRIES = 20

/** 技能来源：插件自带 vs 用户自建（用户自建的 ownerPluginId 见 {@link CUSTOM_OWNER_ID}） */
export type SkillSource = 'plugin' | 'custom'

/** 用户自建技能的「owner」——界面按它归到「用户自建」组 */
export const CUSTOM_OWNER_ID = 'user'

/**
 * `skills.state` / `skills.list.result` 的一条。
 *
 * `ownerPluginId` 是**分组键**（「卸掉某插件会带走什么」），所以它必须是最外层结构；
 * 组内按 name 排序 —— **这一条是给模型的**：`skills.state` 与索引片段的顺序必须
 * `ownerPluginId → name` 稳定，否则 prompt 缓存全失效。
 */
export interface SkillIndexEntry {
  ownerPluginId: string
  name: string
  description: string
  source: SkillSource
  /** 本机可用（机器级开关；`skills.json`）。关掉不删角色绑定，只是本轮不生效 */
  enabled: boolean
}

/** 一个解析出来的技能包（SKILL.md 的 frontmatter + 正文） */
export interface SkillPackage {
  name: string
  description: string
  body: string
}

/** frontmatter 里 `name` 缺省时用目录名兜底；description 可空 */
export function parseSkillMd(text: string, fallbackName: string): SkillPackage {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) {
    return { name: fallbackName, description: '', body: text.trim() }
  }
  const fm = m[1]
  const body = m[2].trim()
  let name = fallbackName
  let description = ''
  for (const line of fm.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1].toLowerCase()
    const val = kv[2].trim().replace(/^["']|["']$/g, '')
    if (key === 'name' && val) name = val
    else if (key === 'description') description = val
  }
  return { name, description, body }
}

/** 技能 name 会变成目录名（custom/<name>/），故不许含路径分隔符与危险段 */
export function assertSafeSkillName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 64) return false
  if (name.includes('\0')) return false
  if (name.includes('/') || name.includes('\\')) return false
  if (name === '.' || name === '..') return false
  if (/^[a-zA-Z]:/.test(name) || name.startsWith('\\\\')) return false
  if (/[. ]$/.test(name)) return false
  return true
}

/**
 * 索引排序：**ownerPluginId → name**（确定性）。
 * 与 `skills.state` / 索引片段 / 界面三处共用同一条，保证「用户看到的就是模型看到的」。
 */
export function sortSkillIndex(entries: readonly SkillIndexEntry[]): SkillIndexEntry[] {
  return [...entries].sort((a, b) =>
    a.ownerPluginId < b.ownerPluginId
      ? -1
      : a.ownerPluginId > b.ownerPluginId
        ? 1
        : a.name < b.name
          ? -1
          : a.name > b.name
            ? 1
            : 0,
  )
}

/**
 * 本机可用 ∩ 角色绑定（AND 唯一落点，服务端）。
 * `bound === undefined`（角色没绑任何技能 / 未知角色）→ 交集为空。
 */
export function intersectRoleSkills(available: readonly SkillIndexEntry[], bound: readonly string[]): SkillIndexEntry[] {
  const set = new Set(bound)
  return available.filter((s) => set.has(s.name))
}

/** 单条索引行占的字节（name + description，UTF-8） */
export function skillIndexBytes(entry: SkillIndexEntry): number {
  return utf8Bytes(entry.name) + utf8Bytes(entry.description)
}

/** 一批技能的索引字节和 */
export function skillIndexTotalBytes(entries: readonly SkillIndexEntry[]): number {
  return entries.reduce((n, e) => n + skillIndexBytes(e), 0)
}

export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length
}

/**
 * 索引片段文本（进 p10）。**顺序必须确定**（`ownerPluginId → name`）。
 * 只放 name + description —— 正文由 `skill_read` 按需取。
 */
export function skillsIndexText(entries: readonly SkillIndexEntry[]): string {
  const sorted = sortSkillIndex(entries.filter((e) => e.enabled))
  if (sorted.length === 0) return ''
  const lines = sorted.map((e) => `- ${e.name}: ${e.description}`.trimEnd())
  return lines.join('\n')
}

/** 角色绑定里引用了、但本机不存在的技能名（悬空引用）；按名字去重排序 */
export function danglingBoundSkills(bound: readonly string[], available: readonly SkillIndexEntry[]): string[] {
  const have = new Set(available.map((s) => s.name))
  return [...new Set(bound.filter((n) => !have.has(n)))].sort()
}
