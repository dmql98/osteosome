<template>
  <div class="main-layout">
    <TopBar />
    <main class="main-layout__body">
      <DockviewLayout />
    </main>
    <div v-if="layout.mode === 'runtime'" class="main-layout__overlay">
      <Button variant="primary" size="sm" @click="exitRuntime">返回编辑</Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import TopBar from './TopBar.vue'
import DockviewLayout from '../layout/DockviewLayout.vue'
import Button from '../components/ui/Button.vue'
import { useLayoutStore } from '../layout/layout.store'

const layout = useLayoutStore()
onMounted(() => { void layout.bootstrap() })

function exitRuntime(): void { layout.setMode('edit') }
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

.main-layout__overlay {
  position: fixed;
  right: var(--space-4);
  bottom: var(--space-4);
  z-index: var(--dv-overlay-z-index);
}
</style>
