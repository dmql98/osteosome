这个目录**故意是空的**：它用来测 `scanPlugins` 的 `empty` 态（目录存在但零个 `plugin.json`）。

需要占位文件是因为 git 不跟踪空目录 —— 否则新克隆/CI 上目录不存在，
`scanPlugins` 会返回 `missing-dir` 而不是 `empty`，测试就变成在测另一件事。

请保持这里没有 `plugin.json`。