import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, truncate } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AUDIENCE_EVENT_KINDS,
  AUDIENCE_FACT_KEYS,
  type AudienceEvent,
  type AudienceEventDraft,
  type AudienceEventPage,
  type AudienceEventQuery,
} from '../../../shared/audienceEvents'

const FILE = /^\d{12}\.jsonl$/
const filterKeys = ['accountId', 'platform', 'userId', 'sessionId', 'traceId', 'kind'] as const
function identifier(value: unknown, required = true): string | undefined {
  if (value === undefined && !required) return undefined
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 300 ||
    [...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new Error('事件标识无效')
  return value
}
function normalize(draft: AudienceEventDraft): AudienceEventDraft {
  if (!draft || !AUDIENCE_EVENT_KINDS.includes(draft.kind)) throw new Error('事件类型无效')
  const result: AudienceEventDraft = {
    accountId: identifier(draft.accountId) as string,
    platform: identifier(draft.platform) as string,
    sessionId: identifier(draft.sessionId) as string,
    traceId: identifier(draft.traceId) as string,
    kind: draft.kind,
  }
  for (const key of ['userId', 'userName', 'sourceEventId', 'sourceType', 'ruleId'] as const) {
    const value = identifier(draft[key], false)
    if (value !== undefined) result[key] = value
  }
  for (const key of ['text', 'detail'] as const) {
    if (draft[key] === undefined) continue
    if (typeof draft[key] !== 'string') throw new Error('事件正文无效')
    result[key] = draft[key].slice(0, 8000)
  }
  for (const key of ['ruleRevision', 'platformTime'] as const) {
    if (draft[key] === undefined) continue
    if (!Number.isSafeInteger(draft[key]) || draft[key] < 0) throw new Error('事件数值无效')
    result[key] = draft[key]
  }
  if (draft.preview !== undefined) {
    if (typeof draft.preview !== 'boolean') throw new Error('事件预览标识无效')
    result.preview = draft.preview
  }
  if (draft.facts !== undefined) {
    if (!draft.facts || typeof draft.facts !== 'object' || Array.isArray(draft.facts))
      throw new Error('事件属性无效')
    result.facts = {}
    for (const key of AUDIENCE_FACT_KEYS) {
      const value = draft.facts[key]
      if (value === undefined) continue
      if (typeof value === 'string') result.facts[key] = value.slice(0, 1000)
      else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
        result.facts[key] = value
      else throw new Error('事件属性值无效')
    }
  }
  return result
}

/** One writer per Electron profile. Async append-only shards, bounded reads, no silent retention. */
export class AudienceEventStore {
  private tail: Promise<unknown> = Promise.resolve()
  private initialized?: Promise<void>
  private shard = 1
  private bytes = 0
  private pending = 0
  private failures = 0
  private lastError?: string
  private readonly shardBytes: number
  constructor(
    private directory: string,
    options: { shardBytes?: number } = {},
  ) {
    this.shardBytes = Math.max(1024, Math.min(options.shardBytes || 512 * 1024, 1024 * 1024))
  }
  get status() {
    return { pending: this.pending, failures: this.failures, lastError: this.lastError }
  }
  private filename(shard: number) {
    return join(this.directory, `${String(shard).padStart(12, '0')}.jsonl`)
  }
  private async files() {
    try {
      return (await readdir(this.directory)).filter(name => FILE.test(name)).sort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
  private initialize() {
    this.initialized ??= (async () => {
      await mkdir(this.directory, { recursive: true })
      const last = (await this.files()).at(-1)
      if (!last) return
      this.shard = Number(last.slice(0, 12))
      const data = await readFile(join(this.directory, last))
      this.bytes = data.lastIndexOf(10) + 1
      // Only the incomplete tail of our final shard is recoverable after interrupted append.
      if (this.bytes !== data.length) await truncate(join(this.directory, last), this.bytes)
    })()
    return this.initialized
  }
  async append(draft: AudienceEventDraft): Promise<AudienceEvent> {
    const entry = { ...normalize(draft), id: randomUUID(), receivedAt: Date.now() }
    if (this.pending >= 10000) {
      this.failures++
      this.lastError = '观众事件写入队列已满'
      throw new Error(this.lastError)
    }
    this.pending++
    const task = this.tail.then(async () => {
      try {
        await this.initialize()
        const line = `${JSON.stringify(entry)}\n`
        const size = Buffer.byteLength(line)
        if (this.bytes && this.bytes + size > this.shardBytes) {
          this.shard++
          this.bytes = 0
        }
        await appendFile(this.filename(this.shard), line, 'utf8')
        this.bytes += size
        this.lastError = undefined
        return entry
      } catch {
        this.initialized = undefined
        this.failures++
        this.lastError = '观众事件写入失败，请检查磁盘空间和目录权限'
        throw new Error(this.lastError)
      } finally {
        this.pending--
      }
    })
    this.tail = task.catch(() => {})
    return task
  }
  async flush() {
    await this.tail
  }
  async query(filter: AudienceEventQuery): Promise<AudienceEventPage> {
    const scope: Record<string, string> = {}
    for (const key of filterKeys) {
      const value = identifier(filter[key], key === 'accountId')
      if (value !== undefined) scope[key] = value
    }
    if (scope.kind && !AUDIENCE_EVENT_KINDS.includes(scope.kind as AudienceEvent['kind']))
      throw new Error('事件类型无效')
    const limit = filter.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit 须为 1～200')
    const hash = createHash('sha256').update(JSON.stringify(scope)).digest('hex')
    let position: { file: number; line: number; scope: string } | undefined
    if (filter.cursor !== undefined) {
      try {
        if (typeof filter.cursor !== 'string' || filter.cursor.length > 400) throw new Error()
        position = JSON.parse(Buffer.from(filter.cursor, 'base64url').toString('utf8'))
        if (
          !position ||
          position.scope !== hash ||
          !Number.isSafeInteger(position.file) ||
          position.file < 1 ||
          position.file > 999999999999 ||
          !Number.isSafeInteger(position.line) ||
          position.line < 0
        )
          throw new Error()
      } catch {
        throw new Error('时间线游标无效或筛选范围已变化')
      }
    }
    await this.flush()
    const files = (await this.files())
      .reverse()
      .filter(name => !position || Number(name.slice(0, 12)) <= position.file)
    const result: AudienceEventPage = { items: [], scanned: 0, corruptLines: 0 }
    let scannedFiles = 0
    for (const [fileIndex, file] of files.entries()) {
      const fileNumber = Number(file.slice(0, 12))
      const raw = await readFile(join(this.directory, file), 'utf8')
      if (raw.length > raw.lastIndexOf('\n') + 1) result.corruptLines++
      const lines = raw
        .slice(0, raw.lastIndexOf('\n') + 1)
        .trimEnd()
        .split('\n')
      const start =
        position?.file === fileNumber ? Math.min(position.line, lines.length - 1) : lines.length - 1
      for (let line = start; line >= 0; line--) {
        if (lines[line]) {
          result.scanned++
          try {
            const entry = JSON.parse(lines[line]) as AudienceEvent
            if (!entry.id || !AUDIENCE_EVENT_KINDS.includes(entry.kind)) throw new Error()
            if (filterKeys.every(key => scope[key] === undefined || entry[key] === scope[key]))
              result.items.push(entry)
          } catch {
            result.corruptLines++
          }
        }
        if (result.items.length === limit) {
          const nextFile = line > 0 ? fileNumber : Number(files[fileIndex + 1]?.slice(0, 12))
          if (Number.isFinite(nextFile))
            result.nextCursor = Buffer.from(
              JSON.stringify({
                file: nextFile,
                line: line > 0 ? line - 1 : Number.MAX_SAFE_INTEGER,
                scope: hash,
              }),
            ).toString('base64url')
          return result
        }
      }
      if (++scannedFiles >= 20 && files[fileIndex + 1]) {
        result.nextCursor = Buffer.from(
          JSON.stringify({
            file: Number(files[fileIndex + 1].slice(0, 12)),
            line: Number.MAX_SAFE_INTEGER,
            scope: hash,
          }),
        ).toString('base64url')
        return result
      }
    }
    return result
  }
}
