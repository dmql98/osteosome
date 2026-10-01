<template>
  <div class="ui-settings">
    <div class="ui-settings__row">
      <span class="ui-settings__label">{{ t('settings.ui.theme') }}</span>
      <Select
        :model-value="theme"
        :options="[
          { label: t('settings.ui.themeLight'), value: 'light' },
          { label: t('settings.ui.themeDark'), value: 'dark' },
        ]"
        aria-label="theme"
        @update:model-value="onThemeChange"
      />
    </div>
    <div class="ui-settings__row">
      <span class="ui-settings__label">{{ t('settings.ui.language') }}</span>
      <Select
        :model-value="locale"
        :options="[
          { label: t('settings.ui.langZh'), value: 'zh-CN' },
          { label: t('settings.ui.langEn'), value: 'en' },
        ]"
        aria-label="language"
        @update:model-value="onLocaleChange"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Select from '@/components/ui/Select.vue'
import { useTheme } from '@/core-sdk/useTheme'
import { usePreferences } from '@/core-sdk/usePreferences'

const { t, locale } = useI18n()
const prefs = usePreferences()
const { theme, setTheme } = useTheme()

function onThemeChange(value: string | number): void {
  const next = value === 'dark' ? 'dark' : 'light'
  setTheme(next)
  // 同步写 preferences：刷新保持（DOM 已即时切换）
  void prefs.patch({ 'ui.theme': next })
}

function onLocaleChange(value: string | number): void {
  const next = value === 'en' ? 'en' : 'zh-CN'
  ;(locale as { value: string }).value = next
  void prefs.patch({ 'ui.locale': next })
}
</script>

<style scoped>
.ui-settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.ui-settings__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.ui-settings__label {
  color: var(--color-text);
  font-size: var(--text-sm);
}
</style>
