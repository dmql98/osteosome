<template>
  <RouterView />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { RouterView } from 'vue-router'
import { useLayoutStore } from './layout/layout.store'

/**
 * 插件 iframe → 宿主的面板请求桥（同 origin，事件直穿顶层窗）。
 *
 * 插件视图没有面板控制器（布局是宿主的），想让用户从空态直达另一个组件
 * （如 composer 的「打开模型设置」），只能托宿主代加。约定一条**专属事件名**
 * 而不是复用任何已有机制 —— `payload = widget id`，宿主照常走
 * `layout.addWidget`（停用/卸载插件的 widget 会在这里被拒，无需插件自己判）。
 */
function onAddWidget(event: Event): void {
  const id = (event as CustomEvent<unknown>).detail
  if (typeof id === 'string') useLayoutStore().addWidget(id)
}

onMounted(() => window.addEventListener('ost:add-widget', onAddWidget))
onBeforeUnmount(() => window.removeEventListener('ost:add-widget', onAddWidget))
</script>
