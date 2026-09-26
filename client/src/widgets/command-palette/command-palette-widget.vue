<script lang="ts">
import { defineWidget } from '@/widgets/definition'

export default defineWidget({
  id: 'widget.command-palette',
  title: '命令台',
  component: () => import('./CommandPaletteWidget.vue'),
})
</script>
