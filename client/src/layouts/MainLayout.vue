<template>
  <div class="main-layout">
    <TopBar />
    <main class="main-layout__body">
      <DockviewLayout />
    </main>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import TopBar from './TopBar.vue'
import DockviewLayout from '../layout/DockviewLayout.vue'
import { useLayoutStore } from '../layout/layout.store'
import { usePlugins } from '../core-sdk/usePlugins'

const layout = useLayoutStore()
/**
 * 主窗**必须**自己拉插件清单 —— 这不是「顺便再拉一次」。
 *
 * `usePlugins()` 是唯一会调 `applyCatalog`（`GET /api/plugins`）的地方，而它此前
 * 只在插件列表窗 / 详情窗里被调用（那两个窗各有各的 pinia）。P5/P6 把宿主的
 * widget 注册表清空、所有界面组件都改成插件 `ui.views` 之后，主窗 store 的
 * `views` 就一直是空数组，于是：
 *
 * · `resolveWidget(id, [])` 一律落 `missing` → `layout.store.addWidget` 在
 *   `kind === 'missing'` 处**静默 return** → 详情窗点「加入窗口」毫无反应；
 * · 面板里的盒子画成「未知组件」占位；
 * · `applyDefaultLayout(api, [])` 铺出一个空面板。
 *
 * 三者同一个根因：主窗没清单。放在这里（setup 期调用）是为了让它注册自己的
 * onMounted，早于下面 `layout.bootstrap()` —— 清单与偏好先到位，布局再落。
 */
usePlugins()
onMounted(() => {
  void layout.bootstrap()
})
</script>

<style scoped>
.main-layout {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.main-layout__body {
  display: flex;
  flex: 1;
  min-height: 0;
}
</style>
