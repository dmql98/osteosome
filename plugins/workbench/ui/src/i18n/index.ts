/**
 * workbench 插件自己的 i18n（P6）。
 *
 * ## 为什么是**独立**实例，而不是用宿主那套
 *
 * 插件 UI 是**独立的 JS 上下文**（跑在自己的 iframe 里），宿主的 vue-i18n 实例
 * 在另一个上下文里 —— 拿不到，也不该拿。所以每个插件 UI 要有一份自己的文案。
 *
 * ## 只带 `settings.*` 一个命名空间
 *
 * 宿主那份 i18n 有 `common` / `settings` / `llm` 三块。这个插件只用到 `settings.*`
 * （13 个 key，见 views/SettingsPaneView.vue 及其子树）。搬别的命名空间过来是
 * 「以防万一」，而那会让「这个插件到底依赖哪些文案」变得不可查。
 *
 * ## locale 跟着宿主走
 *
 * iframe 与宿主同源，所以偏好是同一份 `userData/core/preferences.json`。
 * `initLocale` 挂载时读一次 `ui.locale`，于是用户在设置页切语言，
 * 插件界面上刷新后也是新的语言。
 */
import { createI18n } from 'vue-i18n'
import zhSettings from './zh-CN/settings'
import enSettings from './en/settings'

export type Locale = 'zh-CN' | 'en'
export const DEFAULT_LOCALE: Locale = 'zh-CN'

export const i18n = createI18n({
  legacy: false,
  locale: DEFAULT_LOCALE,
  fallbackLocale: DEFAULT_LOCALE,
  messages: {
    'zh-CN': { ...zhSettings },
    en: { ...enSettings },
  },
})

/** 挂载时读偏好恢复 locale（读不到就保持默认，不阻塞界面） */
export async function initLocale(getPrefs: () => Promise<Record<string, unknown>>): Promise<void> {
  try {
    const prefs = await getPrefs()
    const stored = prefs['ui.locale']
    if (stored === 'zh-CN' || stored === 'en') {
      ;(i18n.global.locale as { value: Locale }).value = stored
    }
  } catch {
    // 读失败 → 保持默认语言
  }
}