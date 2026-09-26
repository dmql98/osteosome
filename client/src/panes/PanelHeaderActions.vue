<template>
  <div v-if="panelId" class="panel-header-actions">
    <IconButton icon="⤢" size="sm" label="拉出独立窗" @click="detach" />
    <IconButton icon="×" size="sm" label="关闭面板" @click="close" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useLayoutStore } from '../layout/layout.store'
import { openPanelWindow } from '../layout/window-manager'
import type { PanelParams } from './types'
import IconButton from '../components/ui/IconButton.vue'

type HeaderParams = {
  activePanel?: { id?: string; params?: PanelParams; api?: { close?: () => void } }
}
const props = defineProps<{ params?: HeaderParams }>()
const layout = useLayoutStore()
const panelId = computed(() => props.params?.activePanel?.id ?? '')

function detach(): void {
  const panel = props.params?.activePanel
  if (panel?.id) openPanelWindow(panel.id, panel.params?.widgets ?? [])
}

function close(): void {
  props.params?.activePanel?.api?.close?.()
}
</script>

<style scoped>
.panel-header-actions { display: inline-flex; align-items: center; gap: 2px; height: 100%; padding: 0 var(--space-2); }
</style>
