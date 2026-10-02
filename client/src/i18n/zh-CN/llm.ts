export default {
  llm: {
    provider: '模型服务商',
    providerName: '名称',
    providerEnabled: '启用',
    addProvider: '新增服务商',
    editProvider: '编辑服务商',
    credential: '凭证',
    selectCredential: '选择凭证',
    newCredential: '新建凭证',
    credentialKey: 'API Key',
    model: '模型',
    staticList: '静态列表',
    staticListHint: '未能从服务商拉取模型列表，显示内置列表',
    retry: '重试策略',
    retryMax: '最大尝试次数',
    retryBaseDelay: '基础退避 (ms)',

    // ── S3：厂商预设表驱动的「新增服务商」──
    /** 区块标题：从 12 家内置预设里挑一家来配置 */
    vendorCatalog: '服务商目录',
    vendorCatalogHint: '从内置预设里挑一家，填入密钥即可使用。加厂商不用改代码。',
    /** 状态徽章 */
    vendorConfigured: '已配置',
    vendorNotConfigured: '未配置',
    vendorNoCredential: '免密钥',
    /** 详情字段 */
    vendorBaseUrl: '接口地址',
    vendorKeyEnv: '密钥环境变量',
    vendorDefaultModel: '默认模型',
    /** 操作 */
    vendorSetKey: '配置密钥',
    vendorRemoveKey: '删除密钥',
    vendorKeySaved: '已保存，该服务商已可用',
    vendorKeyRemoved: '密钥已删除，该服务商已从列表移除',
    vendorKeyMissing: '请输入 API Key',
    /** 说明为什么「配了环境变量」也是已配置 */
    vendorFromEnv: '当前由环境变量提供密钥',
    /** 自定义端点 */
    customEndpoint: '自定义端点',
    customEndpointHint: '自建代理或私有端点。留空密钥 = 免凭证端点。',
    newEndpoint: '新增端点',
    endpointId: '标识（id）',
    endpointBaseUrl: '接口地址',
    endpointDefaultModel: '默认模型（可空）',
    endpointNoCredential: '免密钥（不填 API Key）',
    endpointWire: '协议',
    endpointNeedId: '请填标识',
    endpointNeedBaseUrl: '请填接口地址',
    endpointSaved: '端点已保存，重启服务商后生效',
    endpointIdTaken: '标识已存在',
  },
}
