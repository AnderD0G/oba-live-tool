import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import * as sqlite from 'node:sqlite'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import type { AssistantDeskJournalFilter, AssistantDeskJournalRecord } from './AssistantDeskJournal'

export interface AssistantDeskBackupInfo {
  fileName: string; createdAt: number; recordCount: number; latestSequence: number
  bytes: number; verified: true; method: 'online' | 'vacuum'
}
export interface AssistantDeskDatabaseStatus {
  engine: 'sqlite'; schemaVersion: 1; authoritative: true
  recordCount: number; latestSequence: number; migrationComplete: true
  importedRecords: number; recoveryWarnings: number
  backup: { intervalMs: number; retain: 7; last?: AssistantDeskBackupInfo; nextDueAt?: number; error?: string }
  mirrorWarning?: string
}
export interface AssistantDeskDatabaseOptions {
  now?: () => number
  backupIntervalMs?: number
  backupMode?: 'auto' | 'vacuum'
}
const LEGACY_FILE = /^\d{12}\.jsonl$/
const BACKUP_FILE = /^assistant-desk-\d{13}-[a-z0-9-]+\.sqlite$/
const MAX_RECORD_BYTES = 128 * 1024
const SHARD_BYTES = 1024 * 1024
const DAY = 24 * 60 * 60 * 1000
const PAGE_SIZE = 64
const sqliteBackup = (sqlite as unknown as { backup?: (database: DatabaseSync, path: string) => Promise<number> }).backup
const cores = new Map<string, DatabaseCore>()

function validRecord(value: unknown): value is AssistantDeskJournalRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as AssistantDeskJournalRecord
  return typeof record.type === 'string' && typeof record.accountId === 'string' &&
    typeof record.at === 'number' && Number.isFinite(record.at)
}
function publicError(code: string, message: string) { return Object.assign(new Error(message), { code }) }
function latestKey(record: AssistantDeskJournalRecord): string | undefined {
  const data = record.data as Record<string, unknown> | null
  if (['context', 'policy', 'audience-policy', 'health'].includes(record.type)) return 'current'
  if (!data || typeof data !== 'object') return undefined
  const value = data.id ?? data.uuid ?? data.audienceUuid ?? data.batchId ?? data.key ?? data.requestId
  return typeof value === 'string' && value.length <= 2048 ? value : undefined
}

class DatabaseCore {
  references = 0
  private database?: DatabaseSync
  private insert?: StatementSync
  private latest?: StatementSync
  private initialized?: Promise<void>
  private tail: Promise<void> = Promise.resolve()
  private timer?: ReturnType<typeof setTimeout>
  private backupError?: string
  private lastBackup?: AssistantDeskBackupInfo
  private createdAt = 0
  private lastScheduledAt = 0
  private warned = 0
  private imported = 0
  private legacyLastShard = 0
  private readonly now: () => number
  readonly intervalMs: number
  readonly directory: string
  readonly filename: string
  private readonly sentinel: string
  private readonly backupDirectory: string
  constructor(readonly folder: string, private options: AssistantDeskDatabaseOptions) {
    this.now = options.now ?? Date.now
    this.intervalMs = options.backupIntervalMs ?? DAY
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1 || this.intervalMs > 365 * DAY) throw new Error('数据库备份间隔无效')
    this.directory = join(folder, 'database')
    this.filename = join(this.directory, 'assistant-desk.sqlite')
    this.sentinel = join(this.directory, '.canonical-initialized')
    this.backupDirectory = join(this.directory, 'backups')
  }
  private connect(first = false) {
    if (this.database) return this.database
    mkdirSync(this.directory, { recursive: true })
    if (lstatSync(this.directory).isSymbolicLink()) throw publicError('DATABASE_UNAVAILABLE', '助播数据库目录不可用')
    const existing = existsSync(this.filename)
    const hasBackup = existsSync(this.backupDirectory) && lstatSync(this.backupDirectory).isDirectory() && readdirSync(this.backupDirectory).some(file => BACKUP_FILE.test(file))
    if (!existing && (!first || existsSync(this.sentinel) || hasBackup || existsSync(`${this.filename}-wal`)))
      throw publicError('DATABASE_MISSING', '助播主数据库缺失；请保留现场并核对已验证备份，禁止空库重建')
    if (existing && (!lstatSync(this.filename).isFile() || lstatSync(this.filename).isSymbolicLink() || statSync(this.filename).size < 100))
      throw publicError('DATABASE_CORRUPT', '助播主数据库损坏；请保留现场并核对已验证备份')
    let database: DatabaseSync | undefined
    try {
      database = new DatabaseSync(this.filename)
      const version = Number(database.prepare('PRAGMA user_version').get()!.user_version)
      if (existing && version !== 1) throw new Error('Unexpected canonical schema')
      if (database.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok') throw new Error('Failed integrity check')
      database.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        PRAGMA cache_size=-8192; PRAGMA temp_store=FILE; PRAGMA mmap_size=0;
        PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=8388608;
        CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS records(sequence INTEGER PRIMARY KEY AUTOINCREMENT,record_type TEXT NOT NULL,account_id TEXT NOT NULL,recorded_at REAL NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)));
        CREATE INDEX IF NOT EXISTS records_account_type_sequence ON records(account_id,record_type,sequence);
        CREATE INDEX IF NOT EXISTS records_type_sequence ON records(record_type,sequence);
        CREATE TABLE IF NOT EXISTS latest_records(record_type TEXT NOT NULL,account_id TEXT NOT NULL,entity_id TEXT NOT NULL,sequence INTEGER NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),PRIMARY KEY(record_type,account_id,entity_id)) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS verified_backups(id INTEGER PRIMARY KEY AUTOINCREMENT,file_name TEXT UNIQUE NOT NULL,created_at REAL NOT NULL,bytes INTEGER NOT NULL,mtime_ms REAL NOT NULL);
        PRAGMA user_version=1;`)
      this.database = database
      this.insert = database.prepare('INSERT INTO records(record_type,account_id,recorded_at,payload) VALUES(?,?,?,?)')
      this.latest = database.prepare('INSERT INTO latest_records(record_type,account_id,entity_id,sequence,payload) VALUES(?,?,?,?,?) ON CONFLICT(record_type,account_id,entity_id) DO UPDATE SET sequence=excluded.sequence,payload=excluded.payload')
      return database
    } catch {
      try { database?.close() } catch {}
      throw publicError('DATABASE_CORRUPT', '助播主数据库无法校验或打开；请保留现场并核对备份')
    }
  }
  private meta(key: string) { return this.connect().prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value as string | undefined }
  private setMeta(key: string, value: string) { this.connect().prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value) }
  private add(record: AssistantDeskJournalRecord, payload: string) {
    const result = this.insert!.run(record.type, record.accountId, record.at, payload)
    const key = latestKey(record)
    if (key !== undefined) this.latest!.run(record.type, record.accountId, key, result.lastInsertRowid, payload)
  }
  initialize() {
    this.initialized ??= (async () => {
      const database = this.connect(true)
      if (this.meta('migration_complete') !== '1') {
        // A missing application marker in an already authoritative database is
        // corruption, never permission to recover facts from optional exports.
        // Only a genuinely empty interrupted first import can safely retry.
        if (existsSync(this.sentinel) || database.prepare('SELECT 1 AS present FROM records LIMIT 1').get())
          throw publicError('DATABASE_CORRUPT', '助播数据库迁移完成标记损坏；禁止重新导入日志')
        let count = 0, warnings = 0
        database.exec('BEGIN IMMEDIATE')
        try {
          const legacy = join(this.folder, 'journal')
          let files: string[] = []
          try {
            const directory = await lstat(legacy)
            if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Invalid legacy directory')
            files = (await readdir(legacy)).filter(file => LEGACY_FILE.test(file)).sort()
          }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          for (const file of files) {
            const path = join(legacy, file), details = await lstat(path)
            if (!details.isFile() || details.isSymbolicLink() || details.size > SHARD_BYTES + MAX_RECORD_BYTES) throw new Error('Legacy shard exceeds limit')
            const raw = await readFile(path)
            if (raw.length > SHARD_BYTES + MAX_RECORD_BYTES) throw new Error('Legacy shard changed beyond limit')
            let offset = 0
            for (;;) {
              const end = raw.indexOf(10, offset)
              if (end < 0) { if (offset < raw.length) warnings++; break }
              const line = raw.subarray(offset, end); offset = end + 1
              if (!line.length) continue
              try {
                if (line.length + 1 > MAX_RECORD_BYTES) throw new Error('Oversized record')
                const payload = new TextDecoder('utf-8', { fatal: true }).decode(line)
                const record = JSON.parse(payload)
                if (!validRecord(record)) throw new Error('Invalid record')
                this.add(record, payload); count++
              } catch (error) {
                // Parse/shape problems are recoverable legacy warnings. SQL failures
                // must roll back the entire import instead of silently losing facts.
                if ((error as NodeJS.ErrnoException).code === 'ERR_SQLITE_ERROR') throw error
                warnings++
              }
            }
          }
          this.createdAt = this.now()
          this.setMeta('created_at', String(this.createdAt)); this.setMeta('imported_records', String(count))
          this.setMeta('legacy_last_shard', String(files.length ? Number(files.at(-1)!.slice(0, 12)) : 0))
          this.setMeta('recovery_warnings', String(warnings)); this.setMeta('record_count', String(count))
          this.setMeta('migration_complete', '1')
          database.exec('COMMIT')
        } catch {
          try { database.exec('ROLLBACK') } catch {}
          throw publicError('DATABASE_MIGRATION_FAILED', '旧助播审计迁移未完成；数据库事务已回滚，原日志保留')
        }
      }
      this.createdAt = Number(this.meta('created_at'))
      this.imported = Number(this.meta('imported_records'))
      this.warned = Number(this.meta('recovery_warnings'))
      this.legacyLastShard = Number(this.meta('legacy_last_shard') ?? '0')
      if (![this.createdAt, this.imported, this.warned].every(Number.isFinite)) throw publicError('DATABASE_CORRUPT', '助播数据库迁移元数据损坏')
      if (!Number.isSafeInteger(this.legacyLastShard) || this.legacyLastShard < 0) throw publicError('DATABASE_CORRUPT', '助播数据库迁移日志边界损坏')
      const saved = this.meta('last_backup')
      if (saved) this.lastBackup = JSON.parse(saved)
      if (!existsSync(this.sentinel)) {
        writeFileSync(this.sentinel, 'sqlite-v1\n', { flag: 'wx' })
        const descriptor = openSync(this.sentinel, 'r+')
        try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
      }
      this.schedule()
    })()
    return this.initialized
  }
  private queue<T>(operation: () => T | Promise<T>): Promise<T> {
    const task = this.tail.then(operation)
    this.tail = task.then(() => {}, () => {})
    return task
  }
  async append(record: AssistantDeskJournalRecord, payload: string, guard?: () => boolean) {
    await this.initialize()
    return this.queue(() => {
      // The guard and SQLite commit run synchronously in the same serialized operation.
      if (guard && !guard()) throw Object.assign(new Error('这条消息或草稿已更新，记录未保存'), { code: 'REPLY_CHANGED' })
      if (!validRecord(record)) throw publicError('DATABASE_WRITE_FAILED', '助播事实字段无效，记录未保存')
      const database = this.connect()
      database.exec('BEGIN IMMEDIATE')
      try {
        this.add(record, payload)
        this.setMeta('record_count', String(Number(this.meta('record_count')) + 1))
        database.exec('COMMIT')
      } catch {
        try { database.exec('ROLLBACK') } catch {}
        throw publicError('DATABASE_WRITE_FAILED', '助播数据库事务写入失败；记录未确认保存')
      }
      this.schedule()
    })
  }
  async readLatest(type: string, accountId: string, entityId: string, assertOwner: () => void): Promise<AssistantDeskJournalRecord | undefined> {
    await this.initialize()
    return this.queue(() => {
      assertOwner()
      const row = this.connect().prepare('SELECT payload FROM latest_records WHERE record_type=? AND account_id=? AND entity_id=?').get(type, accountId, entityId)
      if (!row) return undefined
      const record = JSON.parse(row.payload as string)
      if (!validRecord(record) || record.type !== type || record.accountId !== accountId || latestKey(record) !== entityId)
        throw publicError('DATABASE_CORRUPT', '助播数据库索引事实无法解析；请核对备份')
      return record
    })
  }
  async *read(reverse: boolean, filter: AssistantDeskJournalFilter = {}, assertOwner: () => void) {
    await this.initialize(); await this.tail
    assertOwner()
    const maximum = Number(this.connect().prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM records').get()!.n)
    let cursor = reverse ? maximum + 1 : 0
    for (;;) {
      assertOwner()
      // A descending cursor starts at maximum+1 and can only decrease, so it
      // already enforces the snapshot ceiling. A second upper bound makes SQLite
      // seek the fixed maximum and rescan newer rows on every descending page.
      const parameters: (string | number)[] = reverse ? [cursor] : [maximum, cursor]
      const bounds = reverse ? 'sequence<?' : 'sequence<=? AND sequence>?'
      let conditions = ''
      if (filter.type !== undefined) { conditions += ' AND record_type=?'; parameters.push(filter.type) }
      if (filter.accountId !== undefined) { conditions += ' AND account_id=?'; parameters.push(filter.accountId) }
      const rows = this.connect().prepare(`SELECT sequence,payload FROM records WHERE ${bounds}${conditions} ORDER BY sequence ${reverse ? 'DESC' : 'ASC'} LIMIT ${PAGE_SIZE}`).all(...parameters)
      if (!rows.length) return
      for (const row of rows) {
        assertOwner()
        cursor = Number(row.sequence)
        const record = JSON.parse(row.payload as string)
        if (!validRecord(record)) throw publicError('DATABASE_CORRUPT', '助播数据库事实无法解析；请核对备份')
        yield record
      }
      // Async-generator yields alone schedule microtasks. Give Electron timers,
      // IPC and the renderer a turn between bounded recovery pages.
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer)
    if (!this.references) return
    const due = (this.lastBackup?.createdAt ?? this.createdAt) + this.intervalMs
    const delay = Math.max(1, Math.min(0x7fffffff, (this.backupError ? this.lastScheduledAt + Math.min(this.intervalMs, 60_000) : due) - this.now()))
    this.timer = setTimeout(() => {
      this.timer = undefined; this.lastScheduledAt = this.now()
      void this.backup().catch(() => {}).finally(() => this.schedule())
    }, delay)
    this.timer.unref()
  }
  private createBackupValidationWorker(path: string, expected: { count: number; sequence: number }) {
    // Inline source has no bundled-file lookup or account/configuration input.
    return new Worker(`
      const { parentPort, workerData } = require('node:worker_threads')
      const { DatabaseSync } = require('node:sqlite')
      let database, result
      try {
        database = new DatabaseSync(workerData.path, { readOnly: true })
        database.exec('PRAGMA query_only=ON; PRAGMA cache_size=-8192; PRAGMA mmap_size=0; PRAGMA temp_store=FILE')
        if (database.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
            database.prepare("SELECT value FROM metadata WHERE key='migration_complete'").get()?.value !== '1') throw new Error('Invalid backup')
        const count = Number(database.prepare('SELECT COUNT(*) AS n FROM records').get().n)
        const sequence = Number(database.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM records').get().n)
        if (count !== workerData.expected.count || sequence !== workerData.expected.sequence) throw new Error('Inconsistent backup')
        result = { verified: true, count, sequence }
      } finally { database?.close() }
      parentPort.postMessage(result)
    `, { eval: true, execArgv: [], stdout: true, stderr: true, workerData: { path, expected },
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 } })
  }
  private async validateBackup(path: string, expected: { count: number; sequence: number }) {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('Invalid backup file')
    const worker = this.createBackupValidationWorker(path, expected)
    worker.stdout?.resume(); worker.stderr?.resume()
    await new Promise<void>((resolve, reject) => {
      let messages = 0, valid = false, failed = false
      const terminate = () => { failed = true; void worker.terminate().catch(() => {}) }
      const deadline = setTimeout(terminate, 90_000)
      deadline.unref()
      const onMessage = (result: unknown) => {
        messages++
        const value = result as { verified?: boolean; count?: number; sequence?: number } | null
        valid = messages === 1 && value?.verified === true && value.count === expected.count && value.sequence === expected.sequence
        if (!valid) terminate()
      }
      const onError = () => { failed = true }
      // A verification message alone cannot publish a file while its reader is
      // still alive. Node emits all worker messages before the final exit event.
      worker.once('exit', code => {
        clearTimeout(deadline)
        worker.off('message', onMessage); worker.off('error', onError); worker.off('messageerror', terminate)
        if (code === 0 && !failed && messages === 1 && valid) resolve()
        else reject(new Error('Backup validation worker failed'))
      })
      worker.on('message', onMessage); worker.once('error', onError); worker.once('messageerror', terminate)
    })
  }
  private removeBackupSidecars(path: string) {
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${path}${suffix}`
      if (!existsSync(sidecar)) continue
      const details = lstatSync(sidecar)
      if (!details.isFile() || details.isSymbolicLink() || (suffix === '-wal' && details.size !== 0)) throw new Error('Invalid snapshot sidecar')
      unlinkSync(sidecar)
    }
  }
  async backup(): Promise<AssistantDeskBackupInfo> {
    await this.initialize()
    return this.queue(async () => {
      let partial: string | undefined
      try {
        const database = this.connect()
        const expected = { count: Number(this.meta('record_count')), sequence: Number(database.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM records').get()!.n) }
        mkdirSync(this.backupDirectory, { recursive: true })
        if (!lstatSync(this.backupDirectory).isDirectory() || lstatSync(this.backupDirectory).isSymbolicLink()) throw new Error('Invalid backup directory')
        const createdAt = this.now(), fileName = `assistant-desk-${String(Math.floor(createdAt)).padStart(13, '0')}-${randomUUID()}.sqlite`
        if (!BACKUP_FILE.test(fileName)) throw new Error('Invalid backup timestamp')
        const target = join(this.backupDirectory, fileName)
        partial = `${target}.partial`
        const method = typeof sqliteBackup === 'function' && this.options.backupMode !== 'vacuum' ? 'online' : 'vacuum'
        if (method === 'online') await sqliteBackup!(database, partial)
        else database.exec(`VACUUM INTO '${partial.replaceAll("'", "''")}'`)
        await this.validateBackup(partial, expected)
        // A readonly connection may leave empty WAL/shared-memory files for a
        // WAL-mode snapshot. Its worker has exited; keep only the complete file.
        this.removeBackupSidecars(partial)
        const file = openSync(partial, 'r+'); try { fsyncSync(file) } finally { closeSync(file) }
        const bytes = statSync(partial).size
        renameSync(partial, target); partial = undefined
        const info: AssistantDeskBackupInfo = { fileName, createdAt, recordCount: expected.count, latestSequence: expected.sequence, bytes, verified: true, method }
        database.exec('BEGIN IMMEDIATE')
        try {
          database.prepare('INSERT INTO verified_backups(file_name,created_at,bytes,mtime_ms) VALUES(?,?,?,?)').run(fileName, createdAt, bytes, statSync(target).mtimeMs)
          this.setMeta('last_backup', JSON.stringify(info))
          database.exec('COMMIT')
        } catch (error) { try { database.exec('ROLLBACK') } catch {}; throw error }
        this.lastBackup = info; this.backupError = undefined
        // The new snapshot was integrity-checked above. Retention only considers
        // our persisted verification receipts and unchanged file identity/size;
        // it never rereads seven full historical databases in Electron's main thread.
        const complete = database.prepare('SELECT file_name,bytes,mtime_ms FROM verified_backups ORDER BY id').all().filter(receipt => {
          if (typeof receipt.file_name !== 'string' || !BACKUP_FILE.test(receipt.file_name)) return false
          try {
            const details = lstatSync(join(this.backupDirectory, receipt.file_name))
            return details.isFile() && !details.isSymbolicLink() && details.size === receipt.bytes && details.mtimeMs === receipt.mtime_ms
          } catch { return false }
        })
        for (const receipt of complete.slice(0, -7)) {
          unlinkSync(join(this.backupDirectory, receipt.file_name as string))
          database.prepare('DELETE FROM verified_backups WHERE file_name=?').run(receipt.file_name)
        }
        this.schedule()
        return info
      } catch {
        if (partial) for (const path of [`${partial}-wal`, `${partial}-shm`, partial]) {
          try { if (existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()) unlinkSync(path) } catch {}
        }
        this.backupError = '数据库备份未完成；主数据库与既有完整备份保留，请检查磁盘空间和权限'
        this.lastScheduledAt = this.now(); this.schedule()
        throw publicError('DATABASE_BACKUP_FAILED', this.backupError)
      }
    })
  }
  async status(): Promise<AssistantDeskDatabaseStatus> {
    await this.initialize(); await this.tail
    const database = this.connect()
    return { engine: 'sqlite', schemaVersion: 1, authoritative: true, recordCount: Number(this.meta('record_count')),
      latestSequence: Number(database.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM records').get()!.n), migrationComplete: true,
      importedRecords: this.imported, recoveryWarnings: this.warned,
      backup: { intervalMs: this.intervalMs, retain: 7, ...(this.lastBackup ? { last: { ...this.lastBackup } } : {}),
        nextDueAt: this.backupError ? this.lastScheduledAt + Math.min(this.intervalMs, 60_000) : (this.lastBackup?.createdAt ?? this.createdAt) + this.intervalMs, ...(this.backupError ? { error: this.backupError } : {}) } }
  }
  async flush() { await this.tail }
  async exportShardFloor() { await this.initialize(); return this.legacyLastShard }
  async release() {
    this.references--
    await this.initialized?.catch(() => {})
    await this.queue(() => {
      if (this.timer) clearTimeout(this.timer)
      this.timer = undefined
      this.database?.close(); this.database = undefined; this.insert = undefined; this.latest = undefined
      if (this.references) this.schedule()
    })
  }
}

/** Durable per-folder connection ownership; JSON is imported only once. */
export class AssistantDeskDatabase {
  private core: DatabaseCore
  private key: string
  private closed = false
  constructor(folder: string, options: AssistantDeskDatabaseOptions = {}) {
    mkdirSync(folder, { recursive: true })
    const absolute = realpathSync(resolve(folder))
    this.key = process.platform === 'win32' ? absolute.toLowerCase() : absolute
    let core = cores.get(this.key)
    if (!core) { core = new DatabaseCore(absolute, options); cores.set(this.key, core) }
    this.core = core; core.references++
  }
  private check() { if (this.closed) throw new Error('助播数据库连接已关闭') }
  initialize() { this.check(); return this.core.initialize() }
  append(record: AssistantDeskJournalRecord, payload: string, guard?: () => boolean) { this.check(); return this.core.append(record, payload, guard) }
  latest(type: string, accountId: string, entityId: string) { this.check(); return this.core.readLatest(type, accountId, entityId, () => this.check()) }
  async *read(reverse = false, filter?: AssistantDeskJournalFilter) { this.check(); yield* this.core.read(reverse, filter, () => this.check()) }
  status() { this.check(); return this.core.status() }
  backup() { this.check(); return this.core.backup() }
  flush() { return this.core.flush() }
  exportShardFloor() { this.check(); return this.core.exportShardFloor() }
  async close() {
    if (this.closed) return
    this.closed = true; await this.core.release()
    if (!this.core.references && cores.get(this.key) === this.core) cores.delete(this.key)
  }
}
