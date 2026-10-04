export * from './events'
export * from './llm'
export * from './manifest'
export * from './paths'
export * from './plugin-manifest'
export * from './protocol'
export * from './semver'
export * from './types'
export * from './llm/stream'

/**
 * 厂商预设**契约**的具名再导出。
 *
 * 为什么要多这一段：`export *` 编译成 CJS 后是 `__exportStar(require(...))`，rollup 静态
 * 分析不出里面的具名导出。而 client 是仓库里第一个对 `@osteosome/shared` 做**运行时值导入**
 * 的包（此前只有 type-only 导入，编译期就擦掉了），vite 打包时直接报
 * 「WIRE_OPENAI is not exported by shared/dist/index.js」。
 *
 * 具名再导出编译成每个名字一个 `defineProperty` getter，rollup 能静态看到。
 * 纯打包兼容性处理，语义与上面的 `export * from './llm'` 完全一致（不是第二份真源）。
 *
 * P5 起这里**不再导出预设数据**（`VENDOR_PRESETS` / `findVendorPreset` 已删）：
 * 数据在 `plugins/models/catalog.json`，由 `parseVendorCatalog` 校验后使用。
 */
export {
  WIRE_OPENAI,
  declaredWires,
  hasVendorCredential,
  parseVendorCatalog,
  presetsForWire,
  providerServiceIdForWire,
  resolveVendorBaseUrl,
  resolveVendorModel,
  vendorBaseUrlEnvName,
  vendorCredentialRef,
  vendorEnvSuffix,
  vendorModelEnvName,
  type VendorPreset,
} from './llm/vendors'