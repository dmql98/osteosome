// Osteosome 客户端壳（Tauri）。
//
// 定位：纯壳 —— 只负责打开主窗口 + 外部原生独立窗口(插件管理) + 托盘 + 全局快捷键。
// 一切业务（文件 / AI / 会话 / 记忆 / MCP / 插件装配）都在独立的 Node Core 进程里，
// 壳通过 HTTP/SSE (127.0.0.1:1420) 与 Core 通信，不碰业务数据。
//
// 架构：
//   Tauri 壳（Rust, 薄）  ── HTTP/SSE ──►  Node Core（龙骨, 一切业务）  ──►  远程/本地 LLM
//
// 后续需扩展的能力（见 docs/wireframes/index.html）：
//   - 插件管理 = 可拖出主窗口的外部原生窗口（复用 WebviewWindow）
//   - 从插件管理窗口把组件跨窗口拖到主窗口 Panel
//   - 托盘 / 全局快捷键 / 系统集成
// 这些都在此文件 + capabilities 里按需添加，壳保持精简。

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            // 壳就绪后：主窗口自动加载 devUrl(5173) 或打包前端。
            // Core / Vite 由 start-client.cmd 负责启动，壳只做窗口。
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
