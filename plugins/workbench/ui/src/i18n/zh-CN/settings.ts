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
      // 这条 hint 在解释一个非显然的事实：设置不能存进 preferences.json，
      // 因为那个文件住在数据目录里 —— 存一起就是鸡生蛋
      dataDirHint: '写入 {file}，重启 Core 后生效（偏好文件住在数据目录里，这个设置存不进偏好）',
      dataDirDefault: '恢复默认后将使用：{path}',
      dataDirInput: '数据目录路径',
      sourceDefault: '默认',
      sourceConfig: '配置文件',
      sourceCli: '命令行 --data',
      sourceEnv: '环境变量 OST_DATA',
      browse: '浏览…',
      browseTitle: '选择数据目录',
      save: '保存',
      resetDefault: '恢复默认',
      savedOk: '已保存，重启 Core 后生效',
      resetOk: '已恢复默认，重启 Core 后生效',
      dataDirEmpty: '路径不能为空',
      dataDirSaveFailed: '保存失败：{msg}',
      pickUnavailable: '当前环境没有系统目录选择框，请直接输入路径',
      danger: '危险区',
      resetLayout: '重置布局',
      resetLayoutHint: '恢复默认面板布局',
      clearSessions: '清除会话',
      clearSessionsHint: '删除全部会话数据',
    },
  },
}
