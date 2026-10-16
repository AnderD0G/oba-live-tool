import { appendFile, lstat, mkdir, open, readdir, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { AssistantDeskDatabaseStatus as StorageStatus } from '../../../../shared/assistantDesk'
import { AssistantDeskDatabase, type AssistantDeskDatabaseOptions, type AssistantDeskDatabaseStatus } from './AssistantDeskDatabase'

export interface AssistantDeskJournalRecord { type: string; accountId: string; at: number; data: unknown }
export interface AssistantDeskJournalFilter { type?: string; accountId?: string }
export interface AssistantDeskJournalStorage {
  pending: number; dropped: number; recoveryWarnings: number; error?: string
  initialize(): Promise<void>
  append(record: AssistantDeskJournalRecord, guard?: () => boolean): Promise<void>
  read(reverse?: boolean, filter?: AssistantDeskJournalFilter): AsyncGenerator<AssistantDeskJournalRecord>
  latest(type: string, accountId: string, entityId: string): Promise<AssistantDeskJournalRecord | undefined>
  metadata(value: unknown): Promise<void>
  status(): Promise<StorageStatus>
  backup(): Promise<unknown>
  flush(): Promise<void>
  close(): Promise<void>
}
const FILE = /^\d{12}\.jsonl$/
const SHARD_BYTES = 1024 * 1024
const MAX_RECORD_BYTES = 128 * 1024
interface MirrorState { references: number; tail: Promise<void>; initialized?: Promise<void>; ready: boolean; shard: number; bytes: number; warning?: string }
const mirrors = new Map<string, MirrorState>()
export interface AssistantDeskJournalOptions extends AssistantDeskDatabaseOptions { mirror?: boolean }

/** SQLite is canonical. JSONL and metadata are optional bounded audit exports. */
export class AssistantDeskJournal {
  private tail: Promise<void> = Promise.resolve()
  private initialized?: Promise<void>
  private database?: AssistantDeskDatabase
  private pendingBytes = 0
  private closing = false
  private closed = false
  private closePending?: Promise<void>
  private readonly key: string
  private readonly mirror: MirrorState
  pending = 0
  dropped = 0
  recoveryWarnings = 0
  error?: string
  constructor(private folder: string, private options: AssistantDeskJournalOptions = {}) {
    const absolute = resolve(folder)
    this.key = process.platform === 'win32' ? absolute.toLowerCase() : absolute
    let mirror = mirrors.get(this.key)
    if (!mirror) { mirror = { references: 0, tail: Promise.resolve(), ready: false, shard: 1, bytes: 0 }; mirrors.set(this.key, mirror) }
    this.mirror = mirror; mirror.references++
  }
  private name(shard: number) { return `${String(shard).padStart(12, '0')}.jsonl` }
  private initializeMirror() {
    this.mirror.initialized ??= (async () => {
      await mkdir(join(this.folder, 'journal'), { recursive: true })
      const directory = await lstat(join(this.folder, 'journal'))
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Invalid log export directory')
      const floor = await this.database!.exportShardFloor()
      const files = (await readdir(join(this.folder, 'journal'))).filter(file => FILE.test(file)).sort()
      const last = files.at(-1)
      if (!last) { this.mirror.shard = floor + 1; return }
      this.mirror.shard = Number(last.slice(0, 12))
      if (this.mirror.shard <= floor) { this.mirror.shard = floor + 1; this.mirror.bytes = 0; return }
      const file = join(this.folder, 'journal', last), details = await lstat(file)
      if (!details.isFile() || details.isSymbolicLink() || details.nlink > 1) throw new Error('Invalid log export file')
      const bytes = details.size
      this.mirror.bytes = bytes
      let terminated = true
      if (bytes) {
        const handle = await open(file, 'r')
        try { const buffer = Buffer.alloc(1); await handle.read(buffer, 0, 1, bytes - 1); terminated = buffer[0] === 10 }
        finally { await handle.close() }
      }
      if (!terminated || bytes > SHARD_BYTES) { this.mirror.shard++; this.mirror.bytes = 0 }
    })().then(() => { this.mirror.ready = true }).catch(() => { this.mirror.ready = false; this.mirror.warning = '可选 JSON 审计镜像未就绪；SQLite 数据库事实仍可使用' })
    return this.mirror.initialized
  }
  private async mirrorTarget() {
    if (!this.mirror.ready) throw new Error('Log export not initialized')
    const directory = await lstat(join(this.folder, 'journal'))
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Invalid log export directory')
    const file = join(this.folder, 'journal', this.name(this.mirror.shard))
    try {
      const details = await lstat(file)
      if (!details.isFile() || details.isSymbolicLink() || details.nlink > 1) throw new Error('Invalid log export file')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    return file
  }
  private ensureInitialized(): Promise<void> {
    this.initialized ??= (async () => {
      this.database = new AssistantDeskDatabase(this.folder, this.options)
      await this.database.initialize()
      const status = await this.database.status()
      this.recoveryWarnings = status.recoveryWarnings
      if (this.options.mirror !== false) await this.initializeMirror()
    })().catch(error => { this.error = error instanceof Error ? error.message : '助播数据库初始化失败'; throw error })
    return this.initialized
  }
  initialize(): Promise<void> {
    if (this.closing || this.closed) return Promise.reject(new Error('助播审计连接已关闭'))
    return this.ensureInitialized()
  }
  append(record: AssistantDeskJournalRecord, guard?: () => boolean): Promise<void> {
    if (this.closing || this.closed) return Promise.reject(new Error('助播审计连接已关闭'))
    const payload = JSON.stringify(record), line = `${payload}\n`, bytes = Buffer.byteLength(line)
    if (bytes > MAX_RECORD_BYTES || this.pending >= 256 || this.pendingBytes + bytes > 2 * 1024 * 1024) {
      this.dropped++
      this.error = bytes > MAX_RECORD_BYTES ? '审计记录超出128KB上限' : '审计写入队列已满；采集记录未保存'
      return Promise.reject(new Error(this.error))
    }
    const snapshot = JSON.parse(payload) as AssistantDeskJournalRecord
    this.pending++; this.pendingBytes += bytes
    const task = this.mirror.tail.then(async () => {
      await this.ensureInitialized()
      await this.database!.append(snapshot, payload, guard)
      // A committed canonical fact cannot become a drop because its log export failed.
      if (this.options.mirror !== false) {
        try {
          if (this.mirror.bytes && this.mirror.bytes + bytes > SHARD_BYTES) { this.mirror.shard++; this.mirror.bytes = 0 }
          await appendFile(await this.mirrorTarget(), line, 'utf8')
          this.mirror.bytes += bytes; this.mirror.warning = undefined
        } catch { this.mirror.warning = '可选 JSON 审计镜像写入失败；该事实已提交 SQLite 数据库' }
      }
    }).catch(error => {
      if (error && typeof error === 'object' && error.code === 'REPLY_CHANGED') throw error
      this.dropped++; this.error = '助播数据库写入失败，请检查磁盘空间、权限和备份状态'; throw error
    }).finally(() => { this.pending--; this.pendingBytes -= bytes })
    this.mirror.tail = task.catch(() => {})
    this.tail = this.mirror.tail
    return task
  }
  async *read(reverse = false, filter?: AssistantDeskJournalFilter): AsyncGenerator<AssistantDeskJournalRecord> {
    await this.initialize(); await this.flush()
    yield* this.database!.read(reverse, filter)
  }
  /** Exact canonical lookup keeps request replay independent of captured-history size. */
  async latest(type: string, accountId: string, entityId: string): Promise<AssistantDeskJournalRecord | undefined> {
    await this.initialize()
    await this.flush()
    return this.database!.latest(type, accountId, entityId)
  }
  async metadata(value: unknown) {
    if (this.closing || this.closed) throw new Error('助播审计连接已关闭')
    const json = JSON.stringify(value)
    if (Buffer.byteLength(json) > 2 * 1024 * 1024) { this.mirror.warning = '可选助播摘要超出2MB上限；数据库事实仍保留'; return }
    if (this.options.mirror === false) return
    const task = this.mirror.tail.then(async () => {
      try {
        await mkdir(this.folder, { recursive: true })
        await writeFile(join(this.folder, 'metadata.pending'), json, 'utf8')
        await rename(join(this.folder, 'metadata.pending'), join(this.folder, 'metadata.json'))
      } catch { this.mirror.warning = '可选助播摘要导出失败；SQLite 数据库事实仍保留' }
    })
    this.mirror.tail = task.catch(() => {}); this.tail = this.mirror.tail
    await task
  }
  async status(): Promise<AssistantDeskDatabaseStatus> {
    await this.initialize(); await this.flush()
    return { ...await this.database!.status(), ...(this.mirror.warning ? { mirrorWarning: this.mirror.warning } : {}) }
  }
  async backup() { await this.initialize(); await this.flush(); return this.database!.backup() }
  async flush() { await this.tail; await this.mirror.tail; await this.database?.flush() }
  close(): Promise<void> {
    this.closePending ??= (async () => {
      this.closing = true
      let error: unknown
      try { await this.flush() } catch (failure) { error = failure }
      try { await this.database?.close() } catch (failure) { error ??= failure }
      finally {
        this.closed = true; this.mirror.references--
        if (!this.mirror.references && mirrors.get(this.key) === this.mirror) mirrors.delete(this.key)
      }
      if (error) throw error
    })()
    return this.closePending
  }
}
