/**
 * i18n 基础设施（P4 WS-4）—— createI18n + locale 读写 preferences。
 *
 * - 资源按命名空间拆文件：zh-CN/{common,settings,llm}.ts ↔ en/{common,settings,llm}.ts
 *   （同类型不混一个文件；命名空间 = 文件名前缀：`common.*` / `settings.*` / `llm.*`）
 * - locale 持久化走 P1a preferences 通道（`ui.locale`），刷新后从 preferences 恢复。
 */
import { createI18n } from 'vue-i18n'
import zhCommon from './zh-CN/common'
import zhSettings from './zh-CN/settings'
import zhLlm from './zh-CN/llm'
import enCommon from './en/common'
import enSettings from './en/settings'
import enLlm from './en/llm'

export type Locale = 'zh-CN' | 'en'

export const DEFAULT_LOCALE: Locale = 'zh-CN'

const messages = {
  'zh-CN': { ...zhCommon, ...zhSettings, ...zhLlm },
  en: { ...enCommon, ...enSettings, ...enLlm },
}

export const i18n = createI18n({
  legacy: false,
  locale: DEFAULT_LOCALE,
  fallbackLocale: 'zh-CN',
  messages,
})

/** 挂载时读 preferences 恢复 locale（main.ts 调用，刷新即生效） */
export async function initLocale(getPrefs: () => Promise<Record<string, unknown>>): Promise<void> {
  try {
    const prefs = await getPrefs()
    const stored = prefs['ui.locale']
    if (stored === 'zh-CN' || stored === 'en') {
      ;(i18n.global.locale as { value: Locale }).value = stored
    }
  } catch {
    // preferences 读失败 → 保持默认 locale，不阻塞启动
  }
}

export function currentLocale(): Locale {
  return (i18n.global.locale as { value: Locale }).value
}
