<template><Teleport to="body"><div class="ui-toast-container" aria-live="polite"><div v-for="item in items" :key="item.id" class="ui-toast" :class="`ui-toast--${item.type}`" role="status"><span>{{ item.message }}</span><button v-if="item.action" type="button" @click="runAction(item)">{{ item.action.label }}</button><button type="button" aria-label="关闭" @click="dismiss(item.id)">×</button></div></div></Teleport></template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
export interface ToastAction { label: string; run: () => void }
export interface ToastOptions { type?: 'info' | 'success' | 'error'; duration?: number; action?: ToastAction }
interface ToastItem extends Required<Pick<ToastOptions, 'type' | 'duration'>> { id: number; message: string; action?: ToastAction }
const items = ref<ToastItem[]>([]); let nextId = 1; const timers = new Map<number, ReturnType<typeof setTimeout>>()
function toast(message: string, options: ToastOptions = {}): number { const id = nextId++; items.value.push({ id, message, type: options.type ?? 'info', duration: options.duration ?? 3500, action: options.action }); if (options.duration !== 0) timers.set(id, setTimeout(() => dismiss(id), options.duration ?? 3500)); return id }
function dismiss(id: number): void { items.value = items.value.filter((item) => item.id !== id); const timer = timers.get(id); if (timer) clearTimeout(timer); timers.delete(id) }
function runAction(item: ToastItem): void { item.action?.run(); dismiss(item.id) }
onBeforeUnmount(() => timers.forEach(clearTimeout))
defineExpose({ toast, dismiss })
</script>

<style scoped>
.ui-toast-container { position: fixed; right: var(--space-5); bottom: var(--space-5); z-index: var(--z-toast); display: grid; gap: var(--space-2); width: min(360px, calc(100vw - 32px)); }
.ui-toast { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); color: var(--color-text); background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md); box-shadow: var(--shadow-md); }.ui-toast--success { border-color: var(--color-success); }.ui-toast--error { border-color: var(--color-danger); }.ui-toast button { margin-left: auto; border: 0; background: transparent; color: var(--color-primary); cursor: pointer; }.ui-toast button + button { margin-left: 0; color: var(--color-text-muted); }
</style>
