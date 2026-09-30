<script lang="ts">
import { defineWidget } from '@/widgets/definition'

export default defineWidget({
  id: 'widget.llm-chat',
  title: 'LLM 对话',
  component: () => import('./LlmChatWidget.vue'),
})
</script>
