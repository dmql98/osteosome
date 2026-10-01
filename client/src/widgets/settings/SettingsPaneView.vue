<template>
  <Card title="设置" class="settings-pane">
    <Tabs :tabs="tabs" :model-value="activeTab" @update:model-value="activeTab = $event">
      <template #[`tab:llm`]><LlmSettings /></template>
      <template #[`tab:ui`]><UiSettings /></template>
      <template #[`tab:advanced`]><AdvancedSettings /></template>
    </Tabs>
  </Card>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Card from '@/components/ui/Card.vue'
import Tabs from '@/components/ui/Tabs.vue'
import LlmSettings from './llm/LlmSettings.vue'
import UiSettings from './ui/UiSettings.vue'
import AdvancedSettings from './advanced/AdvancedSettings.vue'

const { t } = useI18n()
const activeTab = ref('llm')

const tabs = computed(() => [
  { key: 'llm', label: t('settings.tabs.llm') },
  { key: 'ui', label: t('settings.tabs.ui') },
  { key: 'advanced', label: t('settings.tabs.advanced') },
])
</script>
