<script lang="ts">
import { defineWidget } from '@/widgets/definition'

export default defineWidget({
  id: 'widget.session-list',
  title: '会话列表',
  component: () => import('./SessionListView.vue'),
})
</script>
