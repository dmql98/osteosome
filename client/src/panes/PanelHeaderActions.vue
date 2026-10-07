<template>
  <div v-if="panelId" class="panel-header-actions">
    <IconButton icon="⇱" size="sm" label="拉出独立窗" @click="detach" />
    <IconButton icon="✕" size="sm" label="关闭面板" @click="close" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useLayoutStore } from '../layout/layout.store'
import { openPanelWindow } from '../layout/window-manager'
import type { PanelParams } from './types'
import { IconButton } from '@osteosome/ui'

type HeaderParams = {
  activePanel?: { id?: string; params?: PanelParams; api?: { close?: () => void } }
}
const props = defineProps<{ params?: HeaderParams }>()
const layout = useLayoutStore()
const panelId = computed(() => props.params?.activePanel?.id ?? '')

function detach(): void {
  const panel = props.params?.activePanel
  if (!panel?.id) return
  // 先把面板从工作台摘除，再开独立窗；关闭独立窗时由主窗放回原位
  if (!layout.detachPanel(panel.id)) return
  openPanelWindow(panel.id, panel.params?.widgets ?? [])
}

function close(): void {
  props.params?.activePanel?.api?.close?.()
}
</script>

<style scoped>
.panel-header-actions { display: inline-flex; align-items: center; gap: 2px; height: 100%; padding: 0 var(--space-2); }
/* 面板标签栏为工业蓝底：动作按钮改用高对比浅色 */
.panel-header-actions :deep(.ui-icon-button) { color: var(--color-topbar-text-muted); }
.panel-header-actions :deep(.ui-icon-button:hover:not(:disabled)) { background-color: var(--color-topbar-overlay-strong); color: var(--color-topbar-text); }
</style>
