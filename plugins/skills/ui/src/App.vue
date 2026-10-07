<script setup lang="ts">
/** skills 插件 UI 根组件 —— 单视图（widget.skills）。 */
import { onMounted } from 'vue'
import { usePreferences } from '@osteosome/core-client'
import SkillsView from './views/SkillsView.vue'

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
    <SkillsView />
  </div>
</template>

<style scoped>
.plugin-root { height: 100%; min-height: 0; overflow: hidden; background: var(--color-surface); color: var(--color-text); }
</style>
