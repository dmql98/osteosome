<script lang="ts">
import { defineWidget } from '@/widgets/definition'

export default defineWidget({
  id: 'widget.service-status',
  title: '服务状态',
  component: () => import('./ServiceStatusWidget.vue'),
})
</script>
