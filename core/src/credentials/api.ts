/**
 * 凭证 API（P4 WS-1）—— store 之上的门面，附带总线事件发布。
 *
 * **值永不出 Core**：`credential.saved` / `credential.deleted` 事件只带
 * `{ id, name, provider }`（P4 §3.1 红线）；所有返回给前端的形态都是掩码。
 */
import type { Bus } from '../bus/bus'
import { CredentialStore, CredentialStoreError, type MaskedCredential } from './store'

export interface CredentialInput {
  id?: string
  name: string
  provider: string
  value: string
  kind?: 'apiKey'
}

/** 事件 payload（只增不改，§3.4）：无 value 字段 */
export interface CredentialEvent {
  id: string
  name: string
  provider: string
}

export class CredentialApi {
  constructor(
    private readonly store: CredentialStore,
    private readonly bus: Bus,
  ) {}

  /** 掩码列表（前端通道唯一形态） */
  list(): MaskedCredential[] {
    return this.store.maskedList()
  }

  /** 取原值（**仅服务进程经 JSON-RPC credentials.get**，前端永不走） */
  getRaw(id: string): { value: string } {
    return { value: this.store.get(id).value }
  }

  /** 新建/覆盖 → 发 credential.saved（无值）→ 返回掩码 */
  set(input: CredentialInput): MaskedCredential {
    const masked = this.store.set(input)
    const event: CredentialEvent = { id: masked.id, name: masked.name, provider: masked.provider }
    this.bus.publish('credential.saved', event as never)
    return masked
  }

  /** 删除 → 发 credential.deleted（无值） */
  delete(id: string): boolean {
    const existed = this.store.delete(id)
    if (existed) this.bus.publish('credential.deleted', { id } as never)
    return existed
  }

  isCorrupted(): boolean {
    return this.store.isCorrupted()
  }
}

export { CredentialStoreError }
