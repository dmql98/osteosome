<template>
  <Card title="LLM Providers" padding="none">
    <EmptyState
      v-if="!list.length"
      icon="🔌"
      title="无 provider 注册"
      description="等待 llm.provider.registered 事件…（deepseek / openrouter / openai）"
    />
    <div v-else class="llm-providers">
      <div v-for="entry in list" :key="entry.provider" class="llm-providers__row" :data-testid="`llm-provider-${entry.provider}`">
        <div class="llm-providers__head">
          <span class="llm-providers__name">{{ entry.provider }}</span>
          <span class="llm-providers__model">{{ entry.defaultModel }}</span>
        </div>
        <div class="llm-providers__meta">
          <span>credential: {{ entry.credentialRef }}</span>
          <span>retry: {{ entry.retryPolicy ? `max ${entry.retryPolicy.maxAttempts}` : '—' }}</span>
        </div>
      </div>
    </div>
  </Card>
</template>

<script setup lang="ts">
import Card from '@/components/ui/Card.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useLlmProviders } from '@/core-sdk/useLlmProviders'

const { list } = useLlmProviders()
</script>

<style scoped>
.llm-providers { display: grid; gap: var(--space-2); padding: var(--space-3); }
.llm-providers__row { display: grid; gap: 2px; padding: var(--space-2) var(--space-3); background: var(--color-surface-1); border-radius: var(--radius-md); }
.llm-providers__head { display: flex; align-items: baseline; gap: var(--space-2); }
.llm-providers__name { font-weight: 600; }
.llm-providers__model { font-size: var(--text-sm); color: var(--color-text-muted); }
.llm-providers__meta { display: flex; gap: var(--space-3); font-size: var(--text-xs); color: var(--color-text-muted); }
</style>
