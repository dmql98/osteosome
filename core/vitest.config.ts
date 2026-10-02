import { defineConfig } from 'vitest/config'

/**
 * Core 包测试配置。
 *
 * `fileParallelism: false` —— **集成冒烟必须串行**（P7 定案）：
 * 每个 `*-integration.test.ts` 都会拉起一个真 Core + 9 个真服务进程（≈36 个 node 进程）。
 * 四个冒烟并行时机器被打满，握手 800ms 预算与 20s 等待被挤破 → 假红（表现为
 * `handshake timeout` / `loop idle` 超时，且单独跑必绿）。
 * 单测（bus/framing/manager 等）也跟着串行，总时长换确定性 —— 这正是本仓库的绿灯口径。
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
})