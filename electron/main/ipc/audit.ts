import path from 'node:path'
import { app } from 'electron'
import type { AuditDraft } from '../../../shared/audit'
import { IPC_CHANNELS } from '../../../shared/ipcChannels'
import { AuditLogStore } from '../services/AuditLogStore'
import { typedIpcMainHandle } from '../utils/ipc'

let store: AuditLogStore | undefined
function auditStore() {
  if (!store) store = new AuditLogStore(path.join(app.getPath('userData'), 'audit'))
  return store
}

export function recordAudit(entry: AuditDraft) {
  try {
    auditStore().append(entry)
    return true
  } catch (error) {
    console.error('写入互动审查日志失败', error)
    return false
  }
}

export function setupAuditIpcHandlers() {
  typedIpcMainHandle(IPC_CHANNELS.audit.list, async (_event, accountId?: string) =>
    auditStore().list(300, accountId),
  )
}
