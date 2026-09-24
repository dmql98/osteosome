<script lang="ts">
import { definePane } from '@/panes/definition'

export default definePane({
  id: 'pane.hello',
  title: 'Hello',
  icon: '✦',
  defaultSlot: { area: 'right', index: 0 },
  windowable: true,
  component: () => import('./HelloPane.vue'),
})
</script>
