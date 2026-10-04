<script setup lang="ts">
/**
 * 插件 UI 的根组件：一个视图。
 *
 * 主题跟着宿主走：`data-theme` 写在 `<html>` 上，而 iframe 与宿主同源但**文档独立**，
 * 所以这里读一次宿主的偏好写进自己的 `<html>`。CSS 变量（`tokens.css`）随主题切换，
 * 于是插件界面和工作台看起来是一套东西 —— 不用各自维护一份主题。
 *
 * 读不到偏好不是故障：默认亮色继续（`data-theme` 干脆不设）。
 */
import { onMounted } from 'vue'
import { usePreferences } from '@osteosome/core-client'
import LlmSettingsView from './views/LlmSettingsView.vue'

onMounted(async () => {
  try {
    const prefs = await usePreferences().get()
    const theme = (prefs as { ui?: { theme?: unknown } }).ui?.theme
    if (theme === 'dark' || theme === 'light') {
      document.documentElement.setAttribute('data-theme', theme)
    }
  } catch {
    // 离线/未连接：保持默认主题
  }
})
</script>

<template>
  <div class="plugin-root">
    <LlmSettingsView />
  </div>
</template>

<style scoped>
/*
 * 铺满宿主给的盒子：插件页面不该在 iframe 里再留一圈白边。
 * iframe 元素本身在宿主的 `.panel-boxes__body` 里，那一层已经处理了 padding。
 */
.plugin-root {
  height: 100%;
  min-height: 0;
  overflow: auto;
  background: var(--color-surface);
  color: var(--color-text);
}
</style>