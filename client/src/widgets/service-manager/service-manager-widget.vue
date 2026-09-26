<script lang="ts">
import { defineWidget } from '@/widgets/definition'

export default defineWidget({
  id: 'widget.service-manager',
  title: '服务管理',
  component: () => import('./ServiceManagerWidget.vue'),
})
</script>
