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
          <div class="advanced-settings__row-title">{{ t('settings.advanced.resetLayout') }}</div>
          <div class="advanced-settings__row-hint">{{ t('settings.advanced.resetLayoutHint') }}</div>
        </div>
        <Button variant="danger" size="sm" @click="onResetLayout">{{ t('settings.advanced.resetLayout') }}</Button>
      </div>
      <div class="advanced-settings__row">
        <div>
          <div class="advanced-settings__row-title">{{ t('settings.advanced.clearSessions') }}</div>
          <div class="advanced-settings__row-hint">{{ t('settings.advanced.clearSessionsHint') }}</div>
        </div>
        <Button variant="danger" size="sm" @click="onClearSessions">{{ t('settings.advanced.clearSessions') }}</Button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from '@/components/ui/Button.vue'
import { useLayoutStore } from '@/layout/layout.store'

const { t } = useI18n()
const layout = useLayoutStore()

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

function onResetLayout(): void {
  layout.resetLayout()
}

/** 危险区：清除会话。P3 的 session.clear 命令已可用。 */
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
</style>
