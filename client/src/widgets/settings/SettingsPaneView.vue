<template>
  <Card title="设置" class="settings-pane">
    <Tabs :tabs="tabs" :model-value="activeTab" @update:model-value="activeTab = $event">
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
import UiSettings from './ui/UiSettings.vue'
import AdvancedSettings from './advanced/AdvancedSettings.vue'

/**
 * 这里曾有一个 `llm` tab，已在 S7-7 拆成独立的 `widget.llm-settings`。
 *
 * 拆走的理由不是「tab 太多」，而是**归属**：LLM 服务商配置属于 models 插件，
 * 而 settings 归 workbench（外壳）。留在 settings 里等于让外壳插件替别人管配置。
 *
 * `settings.tabs.llm` 这个 i18n key 也一并删了 —— 留着就是一根指向
 * 不存在 tab 的线，下一个人会照着它去找。
 */
const { t } = useI18n()
const activeTab = ref('ui')

const tabs = computed(() => [
  { key: 'ui', label: t('settings.tabs.ui') },
  { key: 'advanced', label: t('settings.tabs.advanced') },
])
</script>
