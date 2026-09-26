<script lang="ts">
import { defineWidget } from '@/widgets/definition'

export default defineWidget({
  id: 'widget.event-stream',
  title: '事件流',
  component: () => import('./EventStreamWidget.vue'),
})
</script>
