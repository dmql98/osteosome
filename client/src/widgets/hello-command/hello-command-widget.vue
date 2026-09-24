<script lang="ts">
import { defineWidget } from '@/widgets/definition'

export default defineWidget({
  id: 'widget.hello-command',
  title: 'Hello 命令',
  component: () => import('./HelloCommandWidget.vue'),
})
</script>
