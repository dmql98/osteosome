<script lang="ts">
import { defineWidget } from '@/widgets/definition'

export default defineWidget({
  id: 'widget.chat-timeline',
  title: '对话',
  component: () => import('./ChatTimelineWidget.vue'),
})
</script>
