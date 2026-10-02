<script lang="ts">
import { defineWidget } from '@/widgets/definition'

export default defineWidget({
  id: 'widget.settings',
  title: '设置',
  component: () => import('./SettingsPaneView.vue'),
})
</script>
