<script lang="ts">
import { defineWidget } from '@/widgets/definition'

export default defineWidget({
  id: 'widget.chat-composer',
  title: '输入',
  component: () => import('./ChatComposerWidget.vue'),
})
</script>
