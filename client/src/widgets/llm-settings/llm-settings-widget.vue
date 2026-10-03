<script lang="ts">
import { defineWidget } from '@/widgets/definition'

/**
 * 服务商配置面板 —— **S7-7 从 `widget.settings` 的 LLM tab 拆出来**。
 *
 * ## 为什么拆
 *
 * 原来它在 `settings` 里，而 `settings` 归 **workbench** 插件（外壳：系统信息、
 * 命令面板、事件看板、服务管理）。于是「配置 LLM 服务商」这个能力被划给了
 * workbench，而真正拥有 `llm-provider-openai` 的 **models 插件**只剩一个
 * 只读的 `widget.llm-providers` 旁观者。
 *
 * 那与 S7 的归属原则冲突：归属是意图，`settings` 里讲的是
 * `llm-provider-openai` 的配置，跟系统信息面板不是一类东西。
 * 现在 models 同时拥有「配置」（本组件）与「状态」（`widget.llm-providers`）。
 *
 * ## 与 `widget.llm-providers` 的分工（两个都归 models，不是重复）
 *
 * · 本组件：**写**。增删服务商、填 API Key、自填 baseUrl / 选模型
 * · `llm-providers`：**读**。谁注册上来了、用的哪个 credential 引用、retry 策略
 *
 * 分开是有意的：配置是用户意图，更新频率低；状态是运行期事实，
 * 由 `llm.provider.registered` / `unregistered` 驱动。塞进同一个组件会让
 * 「我改了个 Key，到底生效没有」这类问题更难查。
 */
export default defineWidget({
  id: 'widget.llm-settings',
  title: 'LLM 服务商',
  component: () => import('./LlmSettingsView.vue'),
})
</script>