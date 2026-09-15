import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { ElectronTicketAdapter } from '../electron/main/services/ElectronTicketAdapter'
import type { PrintTicket } from '../shared/capturePrinting'

const directory = path.resolve('..', '..', 'outputs', '弹幕捕手验收', 'physical-test-001')
mkdirSync(directory, { recursive: true })
app.setPath('userData', path.join(directory, 'electron-profile'))
const receipt = path.join(directory, 'receipt.json')
const save = (status: string, error = '') =>
  writeFileSync(
    receipt,
    JSON.stringify(
      {
        status,
        error,
        printer: 'KM-202M',
        paper: '40x30',
        copies: 1,
        time: new Date().toISOString(),
      },
      null,
      2,
    ),
  )
void app.whenReady().then(async () => {
  if (existsSync(receipt)) {
    console.log('已有测试提交记录，拒绝重复打印')
    app.quit()
    return
  }
  const now = Date.now()
  const ticket: PrintTicket = {
    id: 'test-physical-001',
    number: 'TEST001',
    sourceId: 'test-physical-001',
    status: 'queued',
    error: '',
    createdAt: now,
    record: {
      id: 'test-physical-001',
      batchId: 'test',
      batchName: '打印效果测试',
      ruleId: 'test',
      ruleName: '纯数字测试',
      accountId: '测试账号',
      messageId: 'test-message-001',
      userId: 'TEST-USER-001',
      nickname: '测试观众',
      content: '零一一',
      code: '011',
      time: now,
      capturedAt: now,
    },
  }
  save('submitting')
  try {
    await new ElectronTicketAdapter().print(ticket, 'KM-202M', '40x30')
    save('submitted')
    console.log('测试标签已提交 KM-202M，共 1 张')
  } catch (error) {
    save('uncertain', error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  } finally {
    app.quit()
  }
})
