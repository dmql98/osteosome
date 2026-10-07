/**
 * 角色契约 —— `userData/plugin/agents/characters.json` 的类型与校验（只增不改）。
 *
 * ## 角色 = 一组**引用**，不是一组实现
 *
 * 一个角色只说「用哪份提示词、绑哪些技能、绑哪些工具、用哪个模型」，
 * 它**不认识**技能的实现，也**不认识**工具的执行体 —— 那是各自服务的事（见
 * `docs/智能体Loop与插件协同设计.html` §3 的失败模式：角色把工具代码打包进自己的 dist/
 * 会让工具退回进程内注册表，装第二个角色就互相污染）。
 *
 * ## 存在性与能力都从「服务」长出来
 *
 * 角色服务把这份用户数据解析成一份纯数据配方（{@link AgentRecipe}）回给 loop；
 * 角色那份提示词片段则作为**普通片段**走既有的 `prompt.fragment.registered` ——
 * 与 reliability 插件发的那条一模一样，**loop 侧零新增机制**。
 *
 * ## 缺失是合法的
 *
 * `skills` / `tools` 里引用的名字在本机不存在（对应插件没装 / 工具没注册）时，
 * **忽略并标一条悬空引用**，不报错、不阻止保存（文档 §8 e2）。
 */
import type { ThinkingEffort } from './llm'

/** 角色提示词片段的 id 前缀 —— `role:<characterId>`，装配器据此挑当前角色的那份 */
export const ROLE_FRAGMENT_PREFIX = 'role:'

/** 角色片段的优先级（p5 层）。数字越小越靠前 */
export const ROLE_FRAGMENT_PRIORITY = 5

/** `role:alice` 形式 */
export function characterFragmentId(characterId: string): string {
  return `${ROLE_FRAGMENT_PREFIX}${characterId}`
}

/** 从 `role:alice` 取回 `alice`；不是角色片段返回 null */
export function characterIdFromFragment(fragmentId: string): string | null {
  return fragmentId.startsWith(ROLE_FRAGMENT_PREFIX) ? fragmentId.slice(ROLE_FRAGMENT_PREFIX.length) || null : null
}

/**
 * 一个角色（`characters.json` 的一条，也是 `agent.state` 载荷的一条）。
 *
 * 名字叫 Brief 是历史（它同时是「下拉数据源」和「编辑器载荷」）——
 * **它没有隐藏字段**：界面改的、服务存的、loop 用的都是这一份。
 */
export interface CharacterBrief {
  /** 全局唯一 id（用户可读的 kebab/中文名，落进 `role:<id>` 片段 id） */
  id: string
  /** 显示名 */
  name: string
  /** 表情符号（代替天枢的「主题色」）；缺失时界面用中性占位 */
  emoji?: string
  /** 人格提示词（p5 单字段）。**为空 = 这个角色对模型而言没有身份**（不是错误，是裸会话） */
  prompt: string
  /** 引用的技能 name（skills 服务）；本机不存在 → 悬空引用 */
  skills: string[]
  /** 引用的工具 name；`'*'` = 不限制（全部工具） */
  tools: string[] | '*'
  /** 模型偏好：省略 = 不覆盖，回落链见 {@link AgentRecipe} */
  provider?: string
  model?: string
  thinking?: ThinkingEffort
  /** 采样参数（如 temperature）；省略 = 用模型默认 */
  params?: Record<string, number>
  /** 阶段 E：外观只存一个字符串（skinId）；本阶段先留字段 */
  skinId?: string
}

export function newCharacter(id: string, name?: string): CharacterBrief {
  return {
    id,
    name: name?.trim() || id,
    prompt: '',
    skills: [],
    // 新角色默认不限制工具（等价于「裸会话」），用户再按需收窄
    tools: '*',
  }
}

/**
 * `agent.state.set` 的 patch —— **合并式**，没给的键不变。
 *
 * 两种操作：upsert 一个角色（按 id 合并）、删除一个角色。
 * 与 `skin.set` 同样不设计成「一条命令三种形态」——它们的失败模式不同。
 */
export interface AgentStatePatch {
  /** upsert：`id` 必填，其余给了才改（合并进现有条目）；不存在则以默认值创建 */
  character?: Partial<CharacterBrief> & { id: string }
  /** 按 id 删除 */
  removed?: string
}

/**
 * 解析配方（`agent.resolve.result.recipe`）—— agent 服务回给 loop 的**纯数据**。
 *
 * 回落链（loop 侧）：`loop.run` 参数 → 角色偏好 → models 插件默认 → env → 硬编码。
 * 所以本配方里 `provider/model/thinking` **可缺省**（缺省 = 不覆盖）。
 */
export interface AgentRecipe {
  characterId: string
  prompt: string
  skills: string[]
  tools: string[] | '*'
  provider?: string
  model?: string
  thinking?: ThinkingEffort
  params?: Record<string, number>
  /** 角色只存字符串；阶段 E 才用 */
  skinId?: string
}

/** character → 配方（哨兵：loop 拿到它就能装配） */
export function toRecipe(character: CharacterBrief): AgentRecipe {
  return {
    characterId: character.id,
    prompt: character.prompt,
    skills: [...character.skills],
    tools: character.tools,
    ...(character.provider ? { provider: character.provider } : {}),
    ...(character.model ? { model: character.model } : {}),
    ...(character.thinking ? { thinking: character.thinking } : {}),
    ...(character.params ? { params: { ...character.params } } : {}),
    ...(character.skinId ? { skinId: character.skinId } : {}),
  }
}

/**
 * 合并式 upsert 一个角色（纯函数，可直测）。
 *
 * 语义：以现有条目为底、patch 的键覆盖；不存在则用 `newCharacter` 建底。
 * `skills` 数组**整体替换**（不给则保留）—— 数组没法「部分合并」，界面每次给全量。
 */
export function mergeCharacterPatch(
  current: CharacterBrief | undefined,
  patch: Partial<CharacterBrief> & { id: string },
): CharacterBrief {
  const base = current ?? newCharacter(patch.id)
  const next: CharacterBrief = {
    ...base,
    id: base.id,
    name: typeof patch.name === 'string' && patch.name.trim() ? patch.name : base.name,
    prompt: typeof patch.prompt === 'string' ? patch.prompt : base.prompt,
    skills: Array.isArray(patch.skills) ? [...patch.skills] : base.skills,
    tools: patch.tools === undefined ? base.tools : patch.tools,
  }
  // 可选字段：显式给了就覆盖/删除（`undefined` 不覆盖，用 null 删除的语义此处不引入）
  assignOptional(next, 'emoji', patch.emoji)
  assignOptional(next, 'provider', patch.provider)
  assignOptional(next, 'model', patch.model)
  assignOptional(next, 'thinking', patch.thinking)
  assignOptional(next, 'skinId', patch.skinId)
  if (patch.params !== undefined) next.params = { ...patch.params }
  return next
}

function assignOptional<K extends keyof CharacterBrief>(target: CharacterBrief, key: K, value: CharacterBrief[K] | undefined): void {
  if (value === undefined) return
  const rec = target as unknown as Record<string, unknown>
  // 空串视为「清掉这个可选项」，避免存下 'provider': '' 这种噪音
  if (typeof value === 'string' && value.trim() === '') {
    delete rec[key]
    return
  }
  rec[key] = value
}

/**
 * 解析并校验 `characters.json`。
 *
 * 与 `parseSkinCatalog` 同一处置：**逐条报、不整份拒** ——
 * 一个角色写坏不该让其余角色一起消失，服务仍能照常启动。
 */
export function parseCharacters(raw: unknown): { characters: CharacterBrief[]; errors: string[] } {
  const errors: string[] = []
  if (!Array.isArray(raw)) return { characters: [], errors: ['characters.json is not an array'] }
  const characters: CharacterBrief[] = []
  const seen = new Set<string>()
  raw.forEach((item, index) => {
    const at = `characters[${index}]`
    const parsed = parseCharacter(item, at, errors)
    if (!parsed) return
    if (seen.has(parsed.id)) {
      errors.push(`${at} (${parsed.id}): duplicate character id`)
      return
    }
    seen.add(parsed.id)
    characters.push(parsed)
  })
  return { characters, errors }
}

function parseCharacter(raw: unknown, at: string, errors: string[]): CharacterBrief | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${at} is not an object`)
    return null
  }
  const c = raw as Record<string, unknown>
  if (typeof c.id !== 'string' || c.id.trim() === '') {
    errors.push(`${at}: id must be a non-empty string`)
    return null
  }
  const id = c.id
  const name = typeof c.name === 'string' && c.name.trim() ? c.name : id
  const prompt = typeof c.prompt === 'string' ? c.prompt : ''
  const skills = Array.isArray(c.skills) ? c.skills.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : []
  const tools = parseTools(c.tools, at, errors)
  if (tools === null) return null
  const out: CharacterBrief = { id, name, prompt, skills, tools }
  for (const key of ['emoji', 'provider', 'model', 'skinId'] as const) {
    if (typeof c[key] === 'string' && c[key] !== '') out[key] = c[key] as string
  }
  if (c.thinking === 'off' || c.thinking === 'low' || c.thinking === 'medium' || c.thinking === 'high') {
    out.thinking = c.thinking
  }
  if (c.params && typeof c.params === 'object' && !Array.isArray(c.params)) {
    const params: Record<string, number> = {}
    for (const [k, v] of Object.entries(c.params as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) params[k] = v
    }
    if (Object.keys(params).length > 0) out.params = params
  }
  return out
}

function parseTools(raw: unknown, at: string, errors: string[]): string[] | '*' | null {
  if (raw === '*' || raw === undefined) return '*'
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
  errors.push(`${at}: tools must be '*' or string[]`)
  return null
}

/**
 * 目录排序：**按 name 码位**（确定顺序，防 prompt 缓存因顺序抖动整片失效）。
 * 与角色 id 无关 —— id 是给片段引用用的，不参与展示排序。
 */
export function sortCharacters(characters: readonly CharacterBrief[]): CharacterBrief[] {
  return [...characters].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** 角色是否有可注入的提示词（决定是否注册片段；空 prompt 不注册，见文档 §8 e4） */
export function hasInjectablePrompt(character: CharacterBrief): boolean {
  return character.prompt.trim() !== ''
}
