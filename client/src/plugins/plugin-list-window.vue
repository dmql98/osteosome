<script lang="ts">
import { defineWidget } from '@/widgets/definition'

export default defineWidget({
  id: 'widget.plugin-list',
  title: '插件列表',
  component: () => import('./PluginListWindow.vue'),
})
</script>
