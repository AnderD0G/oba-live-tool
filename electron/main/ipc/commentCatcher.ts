import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import type { TicketResponse } from '../../../shared/capturePrinting'
import { type CatcherResponse, digitPreset, type RuleDraft } from '../../../shared/commentCatcher'
import { IPC_CHANNELS } from '../../../shared/ipcChannels'
import { emitter } from '../event/eventBus'
import { discussRule } from '../services/CaptureRuleCompiler'
import { CaptureStore } from '../services/CaptureStore'
import { ElectronTicketAdapter } from '../services/ElectronTicketAdapter'
import type { PersistentCodexDraftService } from '../services/PersistentCodexDraftService'
import { TicketPrinter } from '../services/TicketPrinter'
import { typedIpcMainHandle } from '../utils/ipc'

export function setupCommentCatcher(service: PersistentCodexDraftService) {
  let capture: CaptureStore
  let printer: TicketPrinter
  let startupError = ''
  try {
    const dir = path.join(app.getPath('userData'), 'comment-catcher')
    printer = new TicketPrinter(path.join(dir, 'printing.json'), new ElectronTicketAdapter())
    capture = new CaptureStore(path.join(dir, 'captures.json'), records => {
      if (printer.autoQueue) printer.enqueue(records)
    })
  } catch (e) {
    startupError = e instanceof Error ? e.message : '读取捕手数据失败'
  }
  const drafts = new Map<number, RuleDraft>()
  const owners = new Set<number>()
  emitter.on('live-comment', ({ accountId, comment }) =>
    capture?.comment({ ...comment, accountId }),
  )
  emitter.on('comment-listener-stopped', ({ accountId }) => capture?.disconnected(accountId))
  app.on('before-quit', () => {
    capture?.stop()
    if (printer) {
      printer.autoQueue = false
      printer.automatic = null
    }
  })
  typedIpcMainHandle(
    IPC_CHANNELS.catcher.request,
    async (event, command): Promise<CatcherResponse> => {
      try {
        if (startupError) throw new Error(startupError)
        if (!command || typeof command.action !== 'string') throw new Error('无效操作')
        const owner = -20000 - event.sender.id
        if (!owners.has(event.sender.id)) {
          owners.add(event.sender.id)
          event.sender.once('destroyed', () => {
            service.cancel(owner)
            drafts.delete(event.sender.id)
            owners.delete(event.sender.id)
          })
        }
        switch (command.action) {
          case 'state':
            return { ok: true, state: capture.state(command.accountId) }
          case 'discuss': {
            drafts.delete(event.sender.id)
            const draft = await discussRule(service, owner, command.turns)
            if (event.sender.isDestroyed()) throw new Error('窗口已关闭')
            drafts.set(event.sender.id, draft)
            return { ok: true, draft }
          }
          case 'cancel':
            service.cancel(owner)
            drafts.delete(event.sender.id)
            return { ok: true }
          case 'preset': {
            const draft = {
              id: randomUUID(),
              message: '预设：纯数字，支持零一一及全角数字，保留前导零。请检查示例后确认。',
              policy: structuredClone(digitPreset),
            }
            drafts.set(event.sender.id, draft)
            return { ok: true, draft }
          }
          case 'confirm': {
            const d = drafts.get(event.sender.id)
            if (!d?.policy || d.id !== command.draftId)
              throw new Error('规则草稿已失效，请重新生成')
            capture.saveRule(command.name, d.policy)
            drafts.delete(event.sender.id)
            return { ok: true }
          }
          case 'rename':
            capture.rename(command.ruleId, command.name)
            return { ok: true }
          case 'delete':
            capture.deleteRule(command.ruleId)
            return { ok: true }
          case 'start':
            capture.start(
              command.accountId,
              command.ruleId,
              command.dedupe,
              command.batchName,
              command.includeRecent,
              command.maxPerUser,
            )
            return { ok: true }
          case 'stop':
            capture.stop()
            return { ok: true }
          default:
            throw new Error('未知操作')
        }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : '操作失败' }
      }
    },
  )
  typedIpcMainHandle(
    IPC_CHANNELS.tickets.request,
    async (event, command): Promise<TicketResponse> => {
      try {
        if (startupError) throw new Error(startupError)
        if (!command) throw new Error('无效操作')
        const listPrinters = async () => {
          const win = BrowserWindow.fromWebContents(event.sender)
          if (!win) throw new Error('窗口不可用')
          return win.webContents.getPrintersAsync()
        }
        switch (command.action) {
          case 'state':
            return { ok: true, state: printer.state() }
          case 'printers':
            return {
              ok: true,
              printers: (await listPrinters()).map(p => ({
                name: p.name,
                displayName: p.displayName,
              })),
            }
          case 'enqueue':
            printer.enqueue(command.records)
            break
          case 'autoQueue':
            if (typeof command.enabled !== 'boolean') throw new Error('无效开关')
            printer.autoQueue = command.enabled
            break
          case 'automatic':
            if (typeof command.enabled !== 'boolean') throw new Error('无效开关')
            if (command.enabled && !(await listPrinters()).some(p => p.name === command.printer))
              throw new Error('请先选择可用打印机')
            printer.setAutomatic(command.printer, command.paper, command.enabled)
            break
          case 'reset':
            printer.reset(command.id)
            break
          case 'preview':
            await printer.preview(command.ids, command.paper)
            break
          case 'print':
            await printer.print(command.ids, command.printer, command.paper)
            break
          default:
            throw new Error('未知操作')
        }
        return { ok: true, state: printer.state() }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : '打印操作失败' }
      }
    },
  )
}
