<template>
  <Card title="Hello 命令">
    <p class="hello-command__hint">点击按钮向 Core 发送 <code>hello.command</code>，回显会以 Toast 提示。</p>
    <div class="hello-command__actions"><Button :loading="sending" @click="sendHello">发送 hello.command</Button></div>
  </Card>
  <Toast ref="toast" />
</template>

<script setup lang="ts">
import { ref } from 'vue'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import Toast from '@/components/ui/Toast.vue'
import { useCommand } from '@/core-sdk/useCommand'
import { useEventBus } from '@/core-sdk/useEventBus'

const { send } = useCommand()
const toast = ref<{ toast: (message: string, options?: { type?: 'info' | 'success' | 'error' }) => number } | null>(null)
const requestId = `web-${Date.now()}-${Math.random().toString(16).slice(2)}`
const sending = ref(false)

useEventBus('hello.command.executed', (payload) => {
  if (payload && typeof payload === 'object' && 'echo' in payload) toast.value?.toast(`Echo: ${String(payload.echo)}`, { type: 'success' })
})
useEventBus('hello.command.failed', () => toast.value?.toast('hello.command 执行失败', { type: 'error' }))

async function sendHello(): Promise<void> {
  sending.value = true
  const ok = await send('hello.command', { requestId, text: 'hi' })
  sending.value = false
  if (!ok) toast.value?.toast('命令发送失败', { type: 'error' })
}
</script>

<style scoped>
.hello-command__hint { margin: 0; color: var(--color-text-muted); font-size: var(--text-sm); }
.hello-command__actions { display: flex; justify-content: flex-end; margin-top: var(--space-3); }
</style>
