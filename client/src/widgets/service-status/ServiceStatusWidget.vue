<template>
  <Card title="服务状态" padding="none">
    <Table v-if="rows.length" :columns="columns" :rows="rows" row-key="serviceId" />
    <EmptyState v-else title="暂无服务状态" description="等待 Core 推送 service.* 事件。" />
  </Card>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import Card from '@/components/ui/Card.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Table from '@/components/ui/Table.vue'
import { useServiceStatus } from '@/core-sdk/useServiceStatus'

const services = useServiceStatus()
const rows = computed(() => Object.values(services.services).map((service) => ({
  serviceId: service.serviceId,
  status: service.status,
  lastHeartbeat: service.lastSeenAt ? new Date(service.lastSeenAt).toLocaleTimeString() : '—',
})))
const columns = [
  { key: 'serviceId', label: 'serviceId' },
  { key: 'status', label: 'status' },
  { key: 'lastHeartbeat', label: '最后心跳' },
]
</script>
