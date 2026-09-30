<script lang="ts">
import { defineWidget } from '@/widgets/definition'

export default defineWidget({
  id: 'widget.llm-providers',
  title: 'LLM Providers',
  component: () => import('./LlmProvidersWidget.vue'),
})
</script>
