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

const layout = useLayoutStore()
onMounted(() => { void layout.bootstrap() })
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
