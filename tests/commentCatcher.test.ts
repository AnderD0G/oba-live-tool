import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parseRuleDraft } from '../electron/main/services/CaptureRuleCompiler'
import { CaptureStore } from '../electron/main/services/CaptureStore'
import {
  type PrintAdapter,
  TicketPrinter,
  ticketHtml,
} from '../electron/main/services/TicketPrinter'
import {
  type CaptureComment,
  type CaptureRecord,
  digitPreset,
  matchCapture,
  validatePolicy,
} from '../shared/commentCatcher'

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oba-capture-test-'))
  const file = path.join(root, 'captures.json')
  const store = new CaptureStore(file)
  store.saveRule('纯数字', digitPreset)
  return { root, file, store, rule: store.state('a').rules[0] }
}
function comment(id: string, content = '011', user = 'u', accountId = 'a'): CaptureComment {
  return {
    accountId,
    msg_id: id,
    msg_type: 'xiaohongshu_comment',
    nick_name: '同名观众',
    user_id: user,
    content,
    time: 1700000000,
  }
}
const adapter: PrintAdapter = { preview: async () => {}, print: async () => {} }
test('digits keep leading zeros; Chinese/fullwidth are explicit; spaces, text and numeric values differ', () => {
  for (const [s, out] of [
    ['001', '001'],
    ['零〇一', '001'],
    ['１２３', '123'],
    [' 011 ', '011'],
    ['一二三四五六', '123456'],
  ])
    assert.equal(matchCapture(s, digitPreset), out)
  for (const s of ['我要011', '0 11', '十', '两', '1.2', '-1', '', '١٢٣', '123\n456'])
    assert.equal(matchCapture(s, digitPreset), null)
  assert.equal(matchCapture('零一一', { ...digitPreset, chineseDigits: false }), null)
  assert.equal(matchCapture('０１１', { ...digitPreset, fullWidthDigits: false }), null)
  assert.equal(matchCapture('0 11', { ...digitPreset, ignoreSpaces: true }), '011')
  assert.equal(matchCapture('011', { ...digitPreset, minLength: 4 }), null)
})
test('contains-digits extracts first run; keyword policy is literal, never executable', () => {
  assert.equal(matchCapture('买011 再022', { ...digitPreset, kind: 'containsDigits' }), '011')
  assert.equal(
    matchCapture('我要[abc]', { ...digitPreset, kind: 'contains', terms: ['[abc]'] }),
    '我要[abc]',
  )
  assert.equal(matchCapture('abccc', { ...digitPreset, kind: 'equals', terms: ['[abc]'] }), null)
  assert.throws(() => validatePolicy({ ...digitPreset, regex: '(a+)+' }))
  assert.throws(() => validatePolicy({ ...digitPreset, minLength: 0 }))
  assert.throws(() => validatePolicy({ ...digitPreset, maxPerUser: -1 }))
})
test('compiler rejects unsupported operations and accepts clarification without an active rule', () => {
  const q = parseRuleDraft('{"message":"中文数字也算吗？","policy":null}')
  assert.equal(q.policy, undefined)
  assert.throws(() =>
    parseRuleDraft(
      JSON.stringify({ message: '运行代码', policy: { ...digitPreset, code: 'process.exit()' } }),
    ),
  )
  const d = parseRuleDraft(
    JSON.stringify({ message: '请确认', policy: { ...digitPreset, maxPerUser: 3 } }),
  )
  assert.equal(d.policy?.maxPerUser, 3)
})
test('each distinct message counted; transport duplicates and account/host/system events excluded', () => {
  const { store, rule } = fixture()
  store.comment(comment('before'))
  store.start('a', rule.id, 'message', '第一批', false)
  store.comment(comment('one'))
  store.comment(comment('one'))
  store.comment(comment('two'))
  store.comment(comment('other', '011', 'u', 'b'))
  store.comment({ ...comment('self'), is_self: true })
  store.comment({ ...comment('like'), msg_type: 'room_like' })
  const r = store.state('a').records
  assert.equal(r.length, 2)
  assert.deepEqual(
    r.map(r => r.code),
    ['011', '011'],
  )
  assert.equal(r[0].time, 1700000000000)
  assert.notEqual(r[0].id, r[1].id)
})
test('userCode uses user ID, not nickname; quotas span different codes and reset for an explicit new batch', () => {
  const { store, rule } = fixture()
  store.start('a', rule.id, 'userCode', '首批', false, 2)
  store.comment(comment('1'))
  store.comment(comment('2'))
  store.comment(comment('3', '012'))
  store.comment(comment('4', '013'))
  store.comment(comment('5', '011', 'other'))
  store.comment(comment('6', '011', ''))
  assert.equal(store.state('a').records.length, 3)
  assert.match(store.state('a').error, /缺少用户 ID/)
  store.stop()
  store.start('a', rule.id, 'message', '下一批', false, 1)
  store.comment(comment('7', '011'))
  store.comment(comment('8', '012'))
  assert.equal(store.state('a').records.length, 4)
})
test('retroactive filtering is explicit; persistence retains audit while restart disables capture', () => {
  const { store, rule, file } = fixture()
  store.comment(comment('1'))
  store.comment(comment('2', '012'))
  store.start('a', rule.id, 'message', '缓存测试', true, 1)
  assert.equal(store.state('a').records.length, 1)
  const restarted = new CaptureStore(file)
  assert.equal(restarted.state('a').active, null)
  assert.equal(restarted.state('a').rules.length, 1)
  assert.equal(restarted.state('a').records.length, 1)
  store.disconnected('a')
  assert.equal(store.state('a').active, null)
})
function records(): CaptureRecord[] {
  const { store, rule } = fixture()
  store.start('a', rule.id, 'message', '测试', false)
  store.comment(comment('1'))
  store.comment(comment('2'))
  return store.state('a').records
}
test('print inbox is idempotent per capture; repeated comments get distinct short ticket numbers', () => {
  const root = fixture().root
  const printer = new TicketPrinter(path.join(root, 'print.json'), adapter)
  const rs = records()
  printer.enqueue(rs)
  printer.enqueue(rs)
  assert.equal(printer.state().tickets.length, 2)
  assert.deepEqual(
    printer.state().tickets.map(t => t.number),
    ['K000001', 'K000002'],
  )
})
test('status changes only after adapter completes; simultaneous submissions cannot double print', async () => {
  let release!: () => void
  const root = fixture().root
  const printer = new TicketPrinter(path.join(root, 'print.json'), {
    ...adapter,
    print: () =>
      new Promise<void>(r => {
        release = r
      }),
  })
  printer.enqueue(records().slice(0, 1))
  const id = printer.state().tickets[0].id
  const pending = printer.print([id], 'printer', '40x30')
  assert.equal(printer.state().tickets[0].status, 'submitting')
  await assert.rejects(printer.print([id], 'printer', '40x30'))
  release()
  await pending
  assert.equal(printer.state().tickets[0].status, 'submitted')
  await assert.rejects(printer.print([id], 'printer', '40x30'))
})
test('spooler failure does not silently retry; restart converts in-flight jobs to uncertain', async () => {
  const root = fixture().root
  const file = path.join(root, 'print.json')
  const printer = new TicketPrinter(file, {
    ...adapter,
    print: async () => {
      throw new Error('offline')
    },
  })
  printer.enqueue(records())
  await assert.rejects(printer.print([printer.state().tickets[0].id], 'printer', '40x30'))
  assert.equal(printer.state().tickets[0].status, 'uncertain')
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  raw.tickets[1].status = 'submitting'
  writeFileSync(file, JSON.stringify(raw))
  const fresh = new TicketPrinter(file, adapter)
  assert.equal(fresh.state().automatic, null)
  assert.equal(fresh.state().autoQueue, false)
  assert.equal(fresh.state().tickets[1].status, 'uncertain')
})
test('auto queue adapter serializes each new event and disarms on failure', async () => {
  const root = fixture().root
  const submitted: string[] = []
  const printer = new TicketPrinter(path.join(root, 'print.json'), {
    ...adapter,
    print: async t => {
      submitted.push(t.id)
    },
  })
  printer.setAutomatic('printer', '40x30', true)
  printer.enqueue(records())
  await new Promise(r => setTimeout(r, 40))
  assert.equal(submitted.length, 2)
  assert.ok(printer.state().tickets.every(t => t.status === 'submitted'))
})
test('labels escape hostile comments, carry identity and exact 40x30 page size', () => {
  const printer = new TicketPrinter(path.join(fixture().root, 'print.json'), adapter)
  const rs = records()
  rs[0].nickname = '<script>alert(1)</script>'
  printer.enqueue(rs)
  const html = ticketHtml(printer.state().tickets, '40x30')
  assert.ok(html.includes('@page{size:40mm 30mm'))
  assert.ok(html.includes('K000001'))
  assert.ok(html.includes('011'))
  assert.ok(html.includes('ID u'))
  assert.ok(!html.includes('<script>'))
  assert.equal((html.match(/<article>/g) || []).length, 2)
  assert.throws(() =>
    ticketHtml(
      [{ ...printer.state().tickets[0], record: { ...rs[0], code: '0'.repeat(25) } }],
      '40x30',
    ),
  )
})
test('corrupt storage fails closed without overwriting source', () => {
  const file = path.join(fixture().root, 'bad.json')
  writeFileSync(file, 'broken')
  assert.throws(() => new CaptureStore(file))
  assert.equal(readFileSync(file, 'utf8'), 'broken')
})
