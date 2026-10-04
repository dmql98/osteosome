<template>
  <div class="advanced-settings">
    <div class="advanced-settings__section">
      <h3 class="advanced-settings__heading">{{ t('settings.advanced.dataDir') }}</h3>
      <code class="advanced-settings__path">{{ dataDir }}</code>
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
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@osteosome/ui'

const { t } = useI18n()

const dataDir = ref('')

onMounted(async () => {
  try {
    const res = await fetch('/api/info')
    const info = res.ok ? ((await res.json()) as { dataDir?: string }) : {}
    dataDir.value = info.dataDir ?? ''
  } catch {
    dataDir.value = ''
  }
})

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
.advanced-settings__path {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  background: var(--color-bg-subtle);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  word-break: break-all;
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
</style>
