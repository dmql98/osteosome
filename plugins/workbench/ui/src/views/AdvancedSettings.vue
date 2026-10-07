<template>
  <div class="advanced-settings">
    <div class="advanced-settings__section">
      <h3 class="advanced-settings__heading">{{ t('settings.advanced.dataDir') }}</h3>

      <div class="advanced-settings__current">
        <code class="advanced-settings__path">{{ dataDir || '—' }}</code>
        <span class="advanced-settings__badge" :class="`advanced-settings__badge--${source}`">
          {{ sourceLabel }}
        </span>
      </div>

      <div class="advanced-settings__edit">
        <Input
          v-model="draft"
          class="advanced-settings__input"
          :placeholder="t('settings.advanced.dataDirInput')"
          :aria-label="t('settings.advanced.dataDirInput')"
          :disabled="saving"
          @enter="onSave"
        />
        <Button v-if="canBrowse" size="sm" variant="ghost" :disabled="saving" @click="onBrowse">
          {{ t('settings.advanced.browse') }}
        </Button>
        <Button size="sm" :disabled="saving || !dirty" :loading="saving" @click="onSave">
          {{ t('settings.advanced.save') }}
        </Button>
        <Button size="sm" variant="ghost" :disabled="saving || source === 'default'" @click="onReset">
          {{ t('settings.advanced.resetDefault') }}
        </Button>
      </div>

      <p class="advanced-settings__note">
        {{ t('settings.advanced.dataDirHint', { file: configFilePath || 'ost.config.json' }) }}
      </p>
      <p v-if="defaultDataDir" class="advanced-settings__note">
        {{ t('settings.advanced.dataDirDefault', { path: defaultDataDir }) }}
      </p>
      <p v-if="notice" class="advanced-settings__note advanced-settings__note--ok">{{ notice }}</p>
      <p v-if="error" class="advanced-settings__note advanced-settings__note--err">{{ error }}</p>
    </div>

    <div class="advanced-settings__section">
      <h3 class="advanced-settings__heading">{{ t('settings.advanced.danger') }}</h3>
      <div class="advanced-settings__row">
        <div>
          <div class="advanced-settings__row-title">{{ t('settings.advanced.clearSessions') }}</div>
          <div class="advanced-settings__row-hint">{{ t('settings.advanced.clearSessionsHint') }}</div>
        </div>
        <Button variant="danger" size="sm" @click="onClearSessions">{{ t('settings.advanced.clearSessions') }}</Button>
      </div>
      <p class="advanced-settings__note">
        「重置为对话布局」在<b>面板头那个 ↺ 按钮</b>上，不在这里。
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button, Input } from '@osteosome/ui'
import { inTauriShell, pickDirectory } from '../tauri-dialog'

/**
 * `dataDir` 是谁定的 —— 与 `core/src/config/config.ts` 的 `DataDirSource` 对齐
 */
type DataDirSource = 'cli' | 'env' | 'config' | 'default'

const SOURCE_KEY: Record<DataDirSource, string> = {
  default: 'settings.advanced.sourceDefault',
  config: 'settings.advanced.sourceConfig',
  cli: 'settings.advanced.sourceCli',
  env: 'settings.advanced.sourceEnv',
}

const { t } = useI18n()

const dataDir = ref('')
const draft = ref('')
const source = ref<DataDirSource>('default')
const defaultDataDir = ref('')
const configFilePath = ref('')
const saving = ref(false)
const notice = ref('')
const error = ref('')
const canBrowse = ref(false)

const dirty = computed(() => draft.value.trim() !== dataDir.value)
const sourceLabel = computed(() => t(SOURCE_KEY[source.value]))

onMounted(() => {
  // 目录选择框只在 Tauri 壳里存在；浏览器（Vite dev + Core）下这个按钮根本不该出现
  canBrowse.value = inTauriShell()
  void load()
})

/**
 * 数据目录这个设置为什么**不能**走 `usePreferences()`：
 * 偏好住在 `<dataDir>/core/preferences.json` 里，而这个设置决定的正是 dataDir ——
 * 存一起就是鸡生蛋，下次启动不知道去哪读它。所以它有自己的引导配置文件
 * `<应用根>/ost.config.json` 和自己的端点 `/api/config`，见 `core/src/sse-bridge/config.ts`。
 */
async function load(): Promise<void> {
  try {
    const res = await fetch('/api/info')
    if (!res.ok) {
      error.value = t('settings.advanced.dataDirSaveFailed', { msg: `HTTP ${res.status}` })
      return
    }
    const info = (await res.json()) as {
      dataDir?: string
      dataDirSource?: DataDirSource
      defaultDataDir?: string
      configFilePath?: string
    }
    dataDir.value = info.dataDir ?? ''
    draft.value = dataDir.value
    source.value = info.dataDirSource ?? 'default'
    defaultDataDir.value = info.defaultDataDir ?? ''
    configFilePath.value = info.configFilePath ?? ''
  } catch (err) {
    error.value = t('settings.advanced.dataDirSaveFailed', { msg: String(err) })
  }
}

async function putConfig(payload: { dataDir: string | null }): Promise<{ ok: boolean; dataDir: string | null }> {
  saving.value = true
  error.value = ''
  notice.value = ''
  try {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      dataDir?: string | null
      error?: string
    }
    if (!res.ok || body.ok !== true) {
      error.value = t('settings.advanced.dataDirSaveFailed', { msg: body.error ?? `HTTP ${res.status}` })
      return { ok: false, dataDir: null }
    }
    return { ok: true, dataDir: typeof body.dataDir === 'string' ? body.dataDir : null }
  } catch (err) {
    error.value = t('settings.advanced.dataDirSaveFailed', { msg: String(err) })
    return { ok: false, dataDir: null }
  } finally {
    saving.value = false
  }
}

async function onSave(): Promise<void> {
  const value = draft.value.trim()
  if (value === '') {
    error.value = t('settings.advanced.dataDirEmpty')
    return
  }
  const result = await putConfig({ dataDir: value })
  if (!result.ok || result.dataDir === null) return
  // 端点返回的是**解析后的绝对路径**，回填它 dirty 才会归零
  dataDir.value = result.dataDir
  draft.value = result.dataDir
  source.value = 'config'
  notice.value = t('settings.advanced.savedOk')
}

async function onReset(): Promise<void> {
  const result = await putConfig({ dataDir: null })
  if (!result.ok) return
  // 恢复缺省 = 把引导配置里那一项删掉，重启后落到 defaultDataDir
  source.value = 'default'
  dataDir.value = defaultDataDir.value
  draft.value = dataDir.value
  notice.value = t('settings.advanced.resetOk')
}

async function onBrowse(): Promise<void> {
  const result = await pickDirectory(t('settings.advanced.browseTitle'))
  if (result.status === 'ok') {
    draft.value = result.path
    notice.value = ''
    error.value = ''
    return
  }
  if (result.status === 'unavailable') {
    // 不是「用户取消了」，是这个壳里根本没有那个能力 —— 说清楚，别让人对着没反应的按钮发呆
    error.value = t('settings.advanced.pickUnavailable')
  }
}

/**
 * 危险区：清除会话。走 Core 的 `session.clear` 命令 ——
 * **命令**是插件能自己做的事，`fetch('/api/command')` 在同源 iframe 里直接可用。
 */

/**
 * 「重置布局」为什么搬不走（P6 的第一个真实跨边界结论）
 *
 * 搬进 iframe 之后它调不到 `layout.store`：那是宿主的 pinia store，
 * 在另一个 JS 上下文里。而它**本来就不该**搬 ——
 *
 * 「重置为对话布局」要回答的问题是「**现在**有哪些面板、每个面板该放哪几个组件、
 * 默认几何是多少」，而这些答案全都只有宿主知道（`defaultWidgetIds()` 读的是宿主的注册表）。
 * 插件要算它，就得把宿主的状态抄一份过去 —— 而那份抄件立刻会过期。
 *
 * 所以按「谁拥有这个动作」分：命令类（`session.clear`）插件自己发；
 * 布局类动作留在宿主，且宿主本来就有入口（面板头的 ↺）。删掉这里的重复入口不丢功能。
 *
 * 如果将来插件**真的**需要触发宿主动作（比如「这个插件提供新组件，把工作台重铺一次」），
 * 那正是 P7「轻量插件 API」要解决的契约问题 —— 到那时再加一条显式的消息，
 * 而不是让每个插件各自手搓 postMessage。
 */
async function onClearSessions(): Promise<void> {
  await fetch('/api/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: 'session.clear', payload: {} }),
  })
}
</script>

<style scoped>
.advanced-settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}
.advanced-settings__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.advanced-settings__heading {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}
.advanced-settings__current {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.advanced-settings__path {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  background: var(--color-bg-subtle);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  word-break: break-all;
}
.advanced-settings__badge {
  font-size: var(--text-xs);
  padding: 2px var(--space-2);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  white-space: nowrap;
}
.advanced-settings__badge--config {
  color: var(--color-primary);
  border-color: var(--color-primary);
}
.advanced-settings__badge--cli,
.advanced-settings__badge--env {
  color: var(--color-text);
}
.advanced-settings__edit {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.advanced-settings__input {
  flex: 1 1 240px;
}
.advanced-settings__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--color-border);
}
.advanced-settings__row:last-child {
  border-bottom: none;
}
.advanced-settings__row-title {
  font-size: var(--text-sm);
  color: var(--color-text);
}
.advanced-settings__row-hint {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.advanced-settings__note {
  margin: var(--space-2) 0 0;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.advanced-settings__note--ok {
  color: var(--color-primary);
}
.advanced-settings__note--err {
  color: var(--color-danger, #c0392b);
}
</style>
