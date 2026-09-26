<script lang="ts">
import { defineWidget } from '@/widgets/definition'

export default defineWidget({
  id: 'widget.system-info',
  title: '系统信息',
  component: () => import('./SystemInfoWidget.vue'),
})
</script>
