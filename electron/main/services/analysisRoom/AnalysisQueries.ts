import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  AnalysisError,
  type AnalysisPage,
  type AnalysisPageFilter,
  type AnalysisRecord,
  type AnalysisRecordFilter,
  type AnalysisScope,
  type AnalysisSession,
  analysisInteger,
  type FieldSummary,
  type JsonValue,
  validateAnalysisScope,
} from '../../../../shared/analysisRoom'
import { type AnalysisCaptureStore, sameAnalysisScope } from './AnalysisCaptureStore'
import { SqliteAnalysisCaptureStore } from './SqliteAnalysisCaptureStore'

interface Cursor {
  kind: 'sessions' | 'records'
  scope: AnalysisScope
  sessionId?: string
  upper: number
  after?: number
  shard?: string
  offset?: number
}
const pointer = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1')
export class AnalysisQueries {
  private cursorKey = randomBytes(32)
  constructor(private store: AnalysisCaptureStore) {}
  private encode(cursor: Cursor): string {
    const text = Buffer.from(JSON.stringify(cursor)).toString('base64url')
    return `${text}.${createHmac('sha256', this.cursorKey).update(text).digest('base64url')}`
  }
  private decode(
    text: string,
    kind: Cursor['kind'],
    scope: AnalysisScope,
    sessionId?: string,
  ): Cursor {
    try {
      if (text.length > 2048) throw new Error('limit')
      const [payload, signature, extra] = text.split('.')
      const expected = createHmac('sha256', this.cursorKey).update(payload).digest()
      const supplied = Buffer.from(signature, 'base64url')
      if (extra || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        throw new Error('signature')
      const cursor = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Cursor
      if (
        cursor.kind !== kind ||
        !sameAnalysisScope(cursor.scope, scope) ||
        cursor.sessionId !== sessionId
      )
        throw new Error('scope')
      analysisInteger(cursor.upper)
      if (cursor.after !== undefined) analysisInteger(cursor.after)
      if (cursor.offset !== undefined) analysisInteger(cursor.offset)
      if (cursor.shard !== undefined && !/^\d{6}\.jsonl$/.test(cursor.shard))
        throw new Error('shard')
      return cursor
    } catch {
      throw new AnalysisError('ANALYSIS_INVALID_INPUT', '分页凭据失效或范围不一致，请重新加载')
    }
  }
  async sessions(filter: AnalysisPageFilter): Promise<AnalysisPage<AnalysisSession>> {
    validateAnalysisScope(filter.scope)
    const limit = analysisInteger(filter.limit ?? 50, 1, 100)
    await this.store.recover()
    if (this.store instanceof SqliteAnalysisCaptureStore) {
      const cursor = filter.cursor
        ? this.decode(filter.cursor, 'sessions', filter.scope)
        : undefined
      const page = this.store.pageSessions(filter.scope, {
        limit,
        upper: cursor?.upper,
        after: cursor?.after,
      })
      return {
        items: page.items,
        ...(page.nextAfter !== undefined
          ? {
              nextCursor: this.encode({
                kind: 'sessions',
                scope: filter.scope,
                upper: page.upper,
                after: page.nextAfter,
              }),
            }
          : {}),
      }
    }
    const all = this.store.list(filter.scope)
    const cursor = filter.cursor
      ? this.decode(filter.cursor, 'sessions', filter.scope)
      : {
          kind: 'sessions' as const,
          scope: filter.scope,
          upper: all.length ? this.store.order(all[0].id) : 0,
        }
    const candidates = this.store
      .list(filter.scope, cursor.upper)
      .filter(row => cursor.after === undefined || this.store.order(row.id) < cursor.after)
    const items = candidates.slice(0, limit)
    const last = items.at(-1)
    return {
      items,
      ...(candidates.length > limit && last
        ? { nextCursor: this.encode({ ...cursor, after: this.store.order(last.id) }) }
        : {}),
    }
  }
  async records(filter: AnalysisRecordFilter): Promise<AnalysisPage<AnalysisRecord>> {
    validateAnalysisScope(filter.scope)
    const limit = analysisInteger(filter.limit ?? 50, 1, 100)
    await this.store.recover()
    const session = this.store.owned(filter.scope, filter.sessionId)
    const cursor = filter.cursor
      ? this.decode(filter.cursor, 'records', filter.scope, filter.sessionId)
      : {
          kind: 'records' as const,
          scope: filter.scope,
          sessionId: filter.sessionId,
          upper: session.counters.received,
        }
    if (this.store instanceof SqliteAnalysisCaptureStore) {
      const page = this.store.pageRecords(filter.sessionId, {
        upper: cursor.upper,
        after: cursor.after,
        limit,
      })
      return {
        items: page.items,
        ...(page.nextAfter !== undefined
          ? { nextCursor: this.encode({ ...cursor, after: page.nextAfter }) }
          : {}),
      }
    }
    const items: AnalysisRecord[] = []
    let next: Cursor | undefined
    for await (const row of this.store.records(filter.sessionId, cursor.shard, cursor.offset)) {
      if (!row.record || row.record.recordSequence > cursor.upper) continue
      if (items.length === limit && next) return { items, nextCursor: this.encode(next) }
      items.push(row.record)
      next = { ...cursor, shard: row.shard, offset: row.nextOffset }
    }
    return { items }
  }
  async fields(scope: AnalysisScope, sessionId: string): Promise<FieldSummary> {
    await this.store.recover()
    this.store.owned(scope, sessionId)
    const fields = new Map<
      string,
      { path: string; count: number; types: Set<string>; examples: JsonValue[] }
    >()
    let complete = true
    let badLines = 0
    let rows = 0
    for await (const row of this.store.records(sessionId)) {
      if (!row.record) {
        badLines++
        complete = false
        continue
      }
      if (!row.record.complete) complete = false
      const stack: Array<{ path: string; value: JsonValue }> = [
        { path: '', value: row.record.data },
      ]
      while (stack.length) {
        const item = stack.pop()
        if (!item) break
        const { path, value } = item
        const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
        if (path) {
          let entry = fields.get(path)
          if (!entry) {
            if (fields.size >= 1000) {
              complete = false
              continue
            }
            entry = { path, count: 0, types: new Set(), examples: [] }
            fields.set(path, entry)
          }
          entry.count++
          entry.types.add(type)
          if ((value === null || typeof value !== 'object') && entry.examples.length < 3) {
            let example = value
            if (typeof value === 'string') {
              let small = ''
              for (const character of value) {
                if (Buffer.byteLength(JSON.stringify(small + character)) > 256) break
                small += character
              }
              example = small
            }
            if (!entry.examples.some(existing => Object.is(existing, example)))
              entry.examples.push(example)
          }
        }
        if (value && typeof value === 'object') {
          for (const key of Object.keys(value))
            stack.push({
              path: `${path}/${pointer(key)}`,
              value: (value as Record<string, JsonValue>)[key],
            })
        }
      }
      if (++rows % 200 === 0) await new Promise<void>(resolve => setImmediate(resolve))
    }
    return {
      fields: [...fields.values()]
        .map(entry => ({ ...entry, types: [...entry.types].sort() }))
        .sort((a, b) => a.path.localeCompare(b.path)),
      complete,
      badLines,
    }
  }
}
