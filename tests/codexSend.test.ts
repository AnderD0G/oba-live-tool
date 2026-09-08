import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserWindow } from 'electron'
import { isConfirmedSendReceipt } from '../electron/main/platforms/xiaohongshu/sendReceipt'
import { WindowManager } from '../electron/main/windowManager'

test('Qianfan successful send uses common_result 1, not 0', () => {
  const data = { comment: '测试回复', common_response: { common_result: 1 } }
  const receipt = { success: true, code: 0, data }
  assert.equal(isConfirmedSendReceipt(receipt, '测试回复'), true)
  for (const invalid of [
    { ...receipt, success: false },
    { ...receipt, code: 1001 },
    { ...receipt, data: { ...data, comment: '另一条回复' } },
    ...[0, 2, undefined].map(common_result => ({
      ...receipt,
      data: { ...data, common_response: { common_result } },
    })),
    {},
    null,
    undefined,
    '<html>error</html>',
  ])
    assert.equal(isConfirmedSendReceipt(invalid, '测试回复'), false)
})

test('window shutdown does not send an auto-reply update to destroyed webContents', () => {
  const manager = new WindowManager()
  let windowDestroyed = false
  let contentsDestroyed = false
  let sends = 0
  const window = {
    on: () => {},
    isDestroyed: () => windowDestroyed,
    webContents: {
      isDestroyed: () => contentsDestroyed,
      send: () => {
        sends++
      },
    },
  } as unknown as BrowserWindow
  manager.setMainWindow(window)
  const state = { enabled: false, accountId: null, message: '已关闭', records: [] }
  assert.equal(manager.send('codexAuto:changed', state), true)
  contentsDestroyed = true
  assert.equal(manager.send('codexAuto:changed', state), false)
  windowDestroyed = true
  assert.equal(manager.send('codexAuto:changed', state), false)
  assert.equal(sends, 1)
})
