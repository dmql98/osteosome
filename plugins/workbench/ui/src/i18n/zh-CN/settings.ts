export default {
  settings: {
    title: '设置',
    // S7-7：`llm` tab 已拆成独立的 widget.llm-settings（归 models 插件），
    // 所以这里不再有 settings.tabs.llm —— 留着就是一根指向不存在 tab 的线
    tabs: { ui: '界面', advanced: '高级' },
    ui: {
      theme: '主题',
      themeLight: '浅色',
      themeDark: '深色',
      language: '语言',
      langZh: '中文',
      langEn: 'English',
    },
    advanced: {
      retryGlobal: '全局重试参数',
      logLevel: '日志级别',
      dataDir: '数据目录',
      danger: '危险区',
      resetLayout: '重置布局',
      resetLayoutHint: '恢复默认面板布局',
      clearSessions: '清除会话',
      clearSessionsHint: '删除全部会话数据',
    },
  },
}
