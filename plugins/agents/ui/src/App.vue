<script setup lang="ts">
/**
 * agents 插件 UI 的根组件 —— 单视图（widget.agents）。
 * 主题随 `data-theme`（宿主偏好），写法与 models/chat-workbench 的 App 一致。
 */
import { onMounted } from 'vue'
import { usePreferences } from '@osteosome/core-client'
import AgentRolesView from './views/AgentRolesView.vue'

onMounted(async () => {
  try {
    const prefs = await usePreferences().get()
    const theme = (prefs as { ui?: { theme?: unknown } }).ui?.theme
    if (theme === 'dark' || theme === 'light') document.documentElement.setAttribute('data-theme', theme)
  } catch {
    // 未连接：保持默认主题
  }
})
</script>

<template>
  <div class="plugin-root">
    <AgentRolesView />
  </div>
</template>

<style scoped>
.plugin-root {
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--color-surface);
  color: var(--color-text);
}
</style>
