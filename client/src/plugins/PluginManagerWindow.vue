<template>
  <div class="plugin-win">
    <header class="plugin-win__bar" data-tauri-drag-region>
      <!-- 返回只出现在详情页：列表是这一层窗口的根，没有上一层 -->
      <button
        v-if="selectedId"
        type="button"
        class="plugin-win__back"
        title="返回插件列表"
        aria-label="返回插件列表"
        @click="showList"
      >←</button>
      <span class="plugin-win__title" data-tauri-drag-region>{{ title }}</span>
      <span class="plugin-win__spacer" data-tauri-drag-region></span>
      <WindowControls />
    </header>

    <!--
      列表 ↔ 详情在**同一个窗口内**切换（不再为每个插件另开窗口）。
      用 v-if 而不是 keep-alive：详情页要按 pluginId 重新取数据，
      留着旧实例反而会出现「切了插件还显示上一个的字段」。
    -->
    <PluginListView v-if="!selectedId" @open="showDetail" />
    <PluginDetailView v-else :key="selectedId" :plugin-id="selectedId" @back="showList" />
  </div>
</template>

<script setup lang="ts">
/**
 * 插件管理窗口（D1 列表 + D2 详情合为一窗）。
 *
 * ## 为什么详情不再单开窗口
 *
 * 原来的「管理」按钮会再 `new WebviewWindow` 一个只剩插件的窗口：用户从列表点进去，
 * 关掉详情后焦点回到列表窗，中间还多了一个需要单独管理的系统窗口。
 * dsh 的插件管理是「卡片点进去就是配置页」，同一页切换；这里保留**外层独立窗**，
 * 但把列表与详情收进同一窗内切换，行为对齐、窗口数从 N+1 降到 1。
 *
 * 外壳只负责：标题栏（拖拽区 / 返回 / 面包屑 / 窗口按钮）+ 当前该显示哪一页。
 * 数据仍然是每一页自己的 —— `usePlugins` 在子组件里调用，不在外壳里多拉一遍。
 */
import { computed, ref } from 'vue'
import WindowControls from '@/components/layout/WindowControls.vue'
import { usePluginStore } from '@/stores/plugin.store'
import PluginListView from './PluginListView.vue'
import PluginDetailView from './PluginDetailView.vue'

const props = withDefaults(defineProps<{
  /** 直接落到某个插件的配置页（`#/plugin-detail/:id` 深链用） */
  initialPluginId?: string
}>(), { initialPluginId: '' })

const store = usePluginStore()
/** 空串 = 列表页；否则是该插件的配置页 */
const selectedId = ref(props.initialPluginId)

const title = computed(() => {
  const plugin = selectedId.value ? store.byId(selectedId.value) : undefined
  return plugin ? `插件管理 / ${plugin.name}` : '插件管理'
})

function showDetail(pluginId: string): void {
  selectedId.value = pluginId
}

function showList(): void {
  selectedId.value = ''
}
</script>

<style scoped>
.plugin-win { display: flex; flex-direction: column; height: 100%; background: var(--color-surface); }
.plugin-win__bar { display: flex; align-items: center; gap: var(--space-2); height: 40px; padding: 0 0 0 var(--space-3); border-bottom: 1px solid var(--color-border); flex: none; }
.plugin-win__back { width: 22px; height: 22px; padding: 0; border: none; border-radius: var(--radius-md); background: transparent; color: var(--color-text-muted); font-family: inherit; font-size: var(--text-md); line-height: 1; cursor: pointer; flex: none; }
.plugin-win__back:hover { background: var(--color-surface-2); color: var(--color-text); }
.plugin-win__back:focus-visible { outline: 2px solid var(--color-focus-ring); outline-offset: 1px; }
.plugin-win__title { font-weight: 700; font-size: var(--text-md); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plugin-win__spacer { flex: 1; }
</style>
