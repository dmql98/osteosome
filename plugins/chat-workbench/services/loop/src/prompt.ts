/**
 * loop system prompt 装配（P3 WS-3；P5 片段化）。
 *
 * ## 提示词是**每轮重算的运行时值**，不是存量
 *
 * 历史里的 system 一律丢弃、只留本次装配出来的那份（见 `history.ts` 的 buildMessages）——
 * 于是「装/卸插件、切角色」**立即生效，历史不用迁移**。
 *
 * ## 片段来源
 *
 * 各服务 publish `prompt.fragment.registered`（id 全局唯一：`role:<id>` 是角色，
 * 其余是插件级片段，如 reliability）。装配按 `(priority, id)` 排 —— **顺序必须确定**，
 * 否则 prompt 缓存整片失效（token 费用翻十倍且零报错）。
 *
 * `role:*` 片段**只在当前 run 选了对应角色时才纳入**：否则所有角色的提示词会一起塞进上下文。
 */
import { characterFragmentId, characterIdFromFragment } from '@osteosome/shared'

export const DEFAULT_SYSTEM_PROMPT = [
  '你是一个本地桌面 AI 助手的对话后端，运行在 Osteosome 客户端里。',
  '用简体中文回答，语气自然、简洁，不啰嗦。',
  '如果用户的问题超出你的能力或需要外部信息，直接说明，不要编造。',
].join('\n')

/** 一段提示词片段（`prompt.fragment.registered` 的载荷形状） */
export interface PromptFragment {
  pluginId: string
  id: string
  priority: number
  text: string
}

/**
 * 装配 system prompt：**基础人格 + 选中的片段**。
 *
 * @param base        基础提示词（恒在最前）
 * @param fragments   当前已注册片段（无序）
 * @param characterId 本次 run 选的角色（决定纳入哪一个 `role:*` 片段；缺省 = 裸会话）
 */
export function assembleSystemPrompt(base: string, fragments: readonly PromptFragment[], characterId?: string): string {
  const roleId = characterId ? characterFragmentId(characterId) : ''
  const chosen = fragments
    // 纳入：所有非角色片段 + 恰好当前角色那一条
    .filter((f) => characterIdFromFragment(f.id) === null || (roleId !== '' && f.id === roleId))
    // 顺序确定：priority 升序，同优先级按 id 码位
    .sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const parts = [base, ...chosen.map((f) => f.text).filter((t) => t.trim() !== '')]
  return parts.join('\n\n')
}
