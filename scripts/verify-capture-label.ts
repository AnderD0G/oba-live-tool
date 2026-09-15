import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { ticketHtml } from '../electron/main/services/TicketPrinter'
import type { PrintTicket } from '../shared/capturePrinting'

const dir = path.resolve('../../outputs/弹幕捕手验收')
mkdirSync(dir, { recursive: true })
const base: PrintTicket = {
  id: 'sample-1',
  number: 'K000001',
  sourceId: 'sample-1',
  status: 'queued',
  error: '',
  createdAt: Date.now(),
  record: {
    id: 'sample-1',
    batchId: 'sample',
    batchName: '测试批次',
    ruleId: 'sample',
    ruleName: '纯数字扣号',
    accountId: '测试账号',
    messageId: 'sample-1',
    userId: '5f1234567890abcdef123456',
    nickname: '测试观众昵称',
    content: '零一一',
    code: '011',
    time: Date.now(),
    capturedAt: Date.now(),
  },
}
const html = ticketHtml(
  [
    base,
    {
      ...base,
      id: 'sample-2',
      number: 'K000002',
      record: {
        ...base.record,
        code: '0'.repeat(24),
        nickname: '这是一个非常长的观众昵称用于验证裁切',
        userId: 'u'.repeat(40),
      },
    },
  ],
  '40x30',
)
writeFileSync(path.join(dir, '40x30标签预览.html'), html)
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
})
try {
  const page = await browser.newPage({
    viewport: { width: 500, height: 550 },
    deviceScaleFactor: 3,
  })
  await page.setContent(html)
  const sizes = await page
    .locator('article')
    .evaluateAll(nodes =>
      nodes.map(n => ({
        height: n.getBoundingClientRect().height,
        scroll: n.scrollHeight,
        client: n.clientHeight,
        width: n.getBoundingClientRect().width,
      })),
    )
  assert.ok(
    sizes.every(
      s =>
        s.scroll <= s.client && Math.abs(s.width - 151.18) < 1 && Math.abs(s.height - 113.38) < 1,
    ),
    JSON.stringify(sizes),
  )
  await page.screenshot({ path: path.join(dir, '40x30标签预览.png'), fullPage: true })
  await page.pdf({
    path: path.join(dir, '40x30标签测试.pdf'),
    preferCSSPageSize: true,
    printBackground: true,
  })
  console.log(JSON.stringify({ ok: true, sizes, dir }))
} finally {
  await browser.close()
}
