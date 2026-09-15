import { randomUUID } from 'node:crypto'
import type { PrintState, PrintTicket } from '../../../shared/capturePrinting'
import type { CaptureRecord } from '../../../shared/commentCatcher'
import { JsonLedger } from './JsonLedger'

export type Paper = '40x30' | 'A4' | '80mm' | '58mm'
interface TicketData {
  version: 1
  tickets: PrintTicket[]
}
export interface PrintAdapter {
  preview(tickets: PrintTicket[], paper: Paper): Promise<void>
  print(ticket: PrintTicket, printer: string, paper: Paper): Promise<void>
}
export function validPaper(paper: string): asserts paper is Paper {
  if (!['40x30', 'A4', '80mm', '58mm'].includes(paper)) throw new Error('不支持的纸张尺寸')
}
export class TicketPrinter {
  private ledger: JsonLedger<TicketData>
  private busy = false
  private error = ''
  autoQueue = false
  automatic: { printer: string; paper: Paper } | null = null
  constructor(
    file: string,
    private adapter: PrintAdapter,
  ) {
    this.ledger = new JsonLedger(file, { version: 1, tickets: [] })
    if (this.ledger.data.version !== 1 || !Array.isArray(this.ledger.data.tickets))
      throw new Error('打印队列格式不兼容')
    if (this.ledger.data.tickets.some(t => t.status === 'submitting'))
      this.ledger.change(d => {
        for (const t of d.tickets)
          if (t.status === 'submitting') {
            t.status = 'uncertain'
            t.error = '上次退出时正在提交，请核对纸张，系统不会自动重打'
          }
      })
  }
  state(): PrintState {
    return structuredClone({
      tickets: this.ledger.data.tickets,
      autoQueue: this.autoQueue,
      automatic: this.automatic,
      error: this.error,
    })
  }
  enqueue(records: CaptureRecord[]) {
    if (!Array.isArray(records) || records.length > 5000)
      throw new Error('一次最多接收 5000 条记录')
    for (const r of records) {
      if (
        !r ||
        [
          'id',
          'batchId',
          'batchName',
          'ruleId',
          'ruleName',
          'accountId',
          'messageId',
          'userId',
          'nickname',
          'content',
          'code',
        ].some(k => typeof r[k as keyof CaptureRecord] !== 'string') ||
        r.content.length > 4000 ||
        r.code.length > 200 ||
        !r.id ||
        !Number.isFinite(r.time)
      )
        throw new Error('打印输入记录无效')
    }
    this.ledger.change(d => {
      const seen = new Set(d.tickets.map(t => t.sourceId))
      for (const r of records) {
        if (seen.has(r.id)) continue
        if (d.tickets.length >= 20000) throw new Error('打印记录达到 20000 条，请先归档')
        seen.add(r.id)
        d.tickets.push({
          id: randomUUID(),
          number: `K${String(d.tickets.length + 1).padStart(6, '0')}`,
          sourceId: r.id,
          record: structuredClone(r),
          status: 'queued',
          error: '',
          createdAt: Date.now(),
        })
      }
    })
    void this.drain()
  }
  private selected(ids: string[]) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || new Set(ids).size !== ids.length)
      throw new Error('请选择 1–50 张单据')
    return ids.map(id => {
      const t = this.ledger.data.tickets.find(t => t.id === id)
      if (!t) throw new Error('单据不存在')
      return structuredClone(t)
    })
  }
  async preview(ids: string[], paper: Paper) {
    validPaper(paper)
    await this.adapter.preview(this.selected(ids), paper)
  }
  async print(ids: string[], printer: string, paper: Paper) {
    validPaper(paper)
    if (!printer) throw new Error('请选择打印机')
    if (this.busy) throw new Error('已有打印任务正在提交')
    const tickets = this.selected(ids)
    if (tickets.some(t => t.status !== 'queued'))
      throw new Error('仅可打印待打印单据；失败或未确认项请先核对并重置')
    this.busy = true
    try {
      for (const t of tickets) await this.submit(t, printer, paper)
    } finally {
      this.busy = false
    }
  }
  private async submit(ticket: PrintTicket, printer: string, paper: Paper) {
    this.ledger.change(d => {
      d.tickets.find(t => t.id === ticket.id)!.status = 'submitting'
    })
    try {
      if (paper === '40x30' && (ticket.record.code.length > 24 || ticket.record.userId.length > 40))
        throw new Error('内容过长，不适合 40×30 标签，请选择更大纸张')
      await this.adapter.print(ticket, printer, paper)
      this.ledger.change(d => {
        d.tickets.find(t => t.id === ticket.id)!.status = 'submitted'
      })
    } catch (e) {
      this.error = e instanceof Error ? e.message : '打印失败'
      this.automatic = null
      this.ledger.change(d => {
        const t = d.tickets.find(t => t.id === ticket.id)!
        t.status = 'uncertain'
        t.error = this.error
      })
      throw e
    }
  }
  reset(id: string) {
    if (this.busy) throw new Error('请等待当前打印完成')
    this.ledger.change(d => {
      const t = d.tickets.find(t => t.id === id)
      if (!t || t.status === 'queued') throw new Error('无需重置')
      t.status = 'queued'
      t.error = ''
    })
  }
  setAutomatic(printer: string, paper: Paper, enabled: boolean) {
    if (!enabled) {
      this.automatic = null
      return
    }
    validPaper(paper)
    if (!printer) throw new Error('请先选择打印机')
    this.error = ''
    this.automatic = { printer, paper }
    void this.drain()
  }
  private async drain() {
    if (!this.automatic || this.busy) return
    this.busy = true
    try {
      while (this.automatic) {
        const next = this.ledger.data.tickets.find(t => t.status === 'queued')
        if (!next) break
        await this.submit(structuredClone(next), this.automatic.printer, this.automatic.paper)
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : '打印失败'
      this.automatic = null
    } finally {
      this.busy = false
    }
  }
}
export function escapeTicket(value: string) {
  return value.replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
}
export function ticketHtml(tickets: PrintTicket[], paper: Paper) {
  validPaper(paper)
  if (paper === '40x30') {
    if (tickets.some(t => t.record.code.length > 24 || t.record.userId.length > 40))
      throw new Error('内容过长，不适合 40×30 标签，请选择更大纸张')
    const e = escapeTicket
    return (
      '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>40×30 扣号标签预览</title><style>@page{size:40mm 30mm;margin:0}*{box-sizing:border-box}body{margin:0;background:#eee;font-family:"Microsoft YaHei",sans-serif;color:#000}article{width:40mm;height:30mm;padding:1.2mm;background:white;margin:5mm auto;break-after:page;overflow-wrap:anywhere}article:last-child{break-after:auto}.top{font-size:10px;font-weight:700;line-height:1.1;display:flex;justify-content:space-between;gap:2px}.code{font-family:monospace;font-weight:800;line-height:1.05;margin:1px 0}.name{font-size:12px;font-weight:700;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.uid{font-family:Consolas,monospace;font-size:12px;font-weight:700;line-height:1.05;margin-top:1px;word-break:break-all}.foot{font-size:10px;font-weight:600;line-height:1.1;margin-top:1px}@media print{body{background:white}article{margin:0}}</style>' +
      tickets
        .map(
          t =>
            '<article><div class="top"><b>扣号待核</b><span>' +
            e(t.number) +
            '</span></div><div class="code" style="font-size:' +
            (t.record.code.length > 12 ? '12' : t.record.code.length > 8 ? '17' : '24') +
            'px">' +
            e(t.record.code) +
            '</div><div class="name">' +
            e(t.record.nickname.slice(0, 12)) +
            (t.record.nickname.length > 12 ? '…' : '') +
            '</div><div class="uid">ID ' +
            e(t.record.userId || '未提供') +
            '</div><div class="foot">' +
            e(
              new Date(t.record.time).toLocaleString('zh-CN', {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              }),
            ) +
            '</div></article>',
        )
        .join('') +
      '</html>'
    )
  }
  const width = paper === 'A4' ? '190mm' : paper === '80mm' ? '70mm' : '48mm'
  const size = paper === 'A4' ? 'A4' : `${paper} 200mm`
  return (
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>扣号单打印预览</title><style>@page{size:' +
    size +
    ';margin:5mm}*{box-sizing:border-box}body{font-family:"Microsoft YaHei",sans-serif;margin:0;color:#000;background:#eee}article{background:white;width:' +
    width +
    ';margin:8mm auto;padding:3mm;break-after:page;overflow-wrap:anywhere}article:last-child{break-after:auto}h1{font-size:20px}h2{font-size:36px;margin:8mm 0;font-family:monospace}p{font-size:12px;line-height:1.6;margin:2mm 0}.muted{font-size:10px}hr{border:0;border-top:1px dashed #000}@media print{body{background:white}article{margin:0}}</style>' +
    tickets
      .map(t => {
        const r = t.record
        const e = escapeTicket
        return (
          '<article><h1>直播扣号单</h1><p>单号 ' +
          e(t.id) +
          '</p><hr><h2>' +
          e(r.code) +
          '</h2><p><b>昵称：</b>' +
          e(r.nickname) +
          '</p><p><b>用户 ID：</b>' +
          e(r.userId || '平台未提供') +
          '</p><p>弹幕：' +
          e(r.content.slice(0, 600)) +
          (r.content.length > 600 ? '（原文过长，完整内容见中控）' : '') +
          '</p><hr><p>时间：' +
          e(new Date(r.time).toLocaleString('zh-CN')) +
          '</p><p>批次：' +
          e(r.batchName) +
          '</p><p>规则：' +
          e(r.ruleName) +
          '</p><p>账号：' +
          e(r.accountId) +
          '</p><p class="muted">评论编号：' +
          e(r.messageId) +
          '</p><p>付款 / 实际订单：待核对</p></article>'
        )
      })
      .join('') +
    '</html>'
  )
}
