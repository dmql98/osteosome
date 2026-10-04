<template><div class="ui-table-wrap"><table class="ui-table"><thead><tr><th v-for="column in columns" :key="column.key" :style="{ textAlign: column.align ?? 'left' }">{{ column.label ?? column.key }}</th></tr></thead><tbody><tr v-for="row in rows" :key="String(row[rowKey])"><td v-for="column in columns" :key="column.key" :style="{ textAlign: column.align ?? 'left' }"><slot :name="`cell:${column.key}`" :row="row" :value="row[column.key]">{{ row[column.key] }}</slot></td></tr></tbody></table><div v-if="!rows.length" class="ui-table__empty">{{ emptyText }}</div></div></template>

<script setup lang="ts">
export interface TableColumn { key: string; label?: string; align?: 'left' | 'center' | 'right'; slot?: string }
withDefaults(defineProps<{ columns: TableColumn[]; rows: Record<string, unknown>[]; rowKey: string; loading?: boolean; emptyText?: string }>(), { loading: false, emptyText: '暂无数据' })
</script>

<style scoped>
.ui-table-wrap { overflow: auto; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); }.ui-table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }.ui-table th, .ui-table td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-border); }.ui-table th { color: var(--color-text-muted); font-weight: 500; background: var(--color-surface-2); }.ui-table tr:last-child td { border-bottom: 0; }.ui-table__empty { padding: var(--space-5); color: var(--color-text-muted); text-align: center; }
</style>
