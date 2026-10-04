/**
 * 插件提供的接入 —— 模型配置页的第四块。
 *
 * ## 为什么给它一块空状态，而不是干脆不写
 *
 * 「wire 不同的第 13 家厂商 = 新进程 + 新插件」是这条架构线里**唯一还没有 UI 落点**的部分：
 * 契约层面已经通（`VendorPreset.api` 是跨进程契约、`buildInstances` 会把不匹配的
 * override 收进 `rejected` 而不是静默丢弃），但用户没有任何地方能看到「插件提供了哪些接入」。
 *
 * 空着的话，这条能力等于不存在。所以明确写出来 —— 哪怕现在是空的。
 *
 * ## 顺带回答一个高频疑问
 *
 * 「ollama / vLLM 算预设还是自填？」—— 两个都是。
 * 预设条目是**开箱能连**（端口写死）；自填是**任意地址**。
 * 改了预设的端口就地改即可，不用删了重填。
 */
<script setup lang="ts">
defineProps<{
  /** 插件注册的 provider id；空数组 = 没有插件提供 */
  pluginProviders: { id: string; label: string; baseUrl: string }[]
}>()

defineEmits<{ (e: 'use', providerId: string): void }>()
</script>

<template>
  <section class="plugin-providers">
    <h3 class="plugin-providers__title">插件提供的接入 ({{ pluginProviders.length }})</h3>

    <div v-for="p in pluginProviders" :key="p.id" class="plugin-provider">
      <span class="plugin-provider__name">{{ p.label }}</span>
      <span class="plugin-provider__url mono">{{ p.baseUrl }}</span>
      <button type="button" class="linkish" @click="$emit('use', p.id)">设为当前</button>
    </div>

    <p v-if="!pluginProviders.length" class="plugin-providers__empty">
      没有插件提供原生 wire 的 provider。
      <b>wire 不同的厂商走这条路</b> —— 请求体不是 OpenAI 兼容时，
      加一个 <code>llm-provider-&lt;wire&gt;</code> 进程与对应插件，
      <code>llm</code> 主位与前端零改动（主位只认 provider 名，不 import 任何实现）。
    </p>

    <p class="plugin-providers__hint">
      ⓘ <b>ollama 和 vLLM 算预设还是自填？</b>两个都是 ——
      预设条目开箱能连（端口写死），自填是任意地址。改了预设的端口就地改即可。
    </p>
  </section>
</template>

<style scoped>
.plugin-providers { display: flex; flex-direction: column; gap: var(--space-2); }
.plugin-providers__title { margin: 0; font-size: var(--text-sm); font-weight: 700; }
.plugin-provider {
  display: flex; align-items: center; gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border); border-radius: var(--radius-md);
}
.plugin-provider__name { font-size: var(--text-sm); font-weight: 600; }
.plugin-provider__url { flex: 1; min-width: 0; font-size: var(--text-xs); overflow-wrap: anywhere; }
.plugin-providers__empty {
  margin: 0; font-size: var(--text-xs); color: var(--color-text-muted); line-height: 1.6;
}
.plugin-providers__hint { margin: 0; font-size: var(--text-xs); color: var(--color-text-muted); }
.linkish {
  background: none; border: none; padding: 0;
  color: var(--color-primary); font: inherit; font-size: var(--text-xs);
  cursor: pointer; text-decoration: underline;
}
</style>