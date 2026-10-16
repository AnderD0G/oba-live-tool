import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { normalizeAssistantHistoryHandle } from '../../../../shared/assistantHistoryIdentity'

const DEFAULT_HOT_LIMIT = 2048
const MAX_HOT_LIMIT = 20000
const HOT_BYTES = 8 * 1024 * 1024

interface CacheEntry { value: string; bytes: number }
interface CacheOwner { clearCache(): void }
interface AudienceValue { accountIds?: string[]; lastSeenAt?: number }
export interface DerivedMapOptions { audience?: boolean; rows?: boolean }
interface RowPageFilter { accountId: string; sessionId?: string; userId?: string; audienceUuid?: string; mentionHandle?: string; nickname?: string; from?: number; to?: number; minPayLevel?: number; before?: { at: number; key: string }; limit: number }
export interface DerivedScope { sessionId: string; receivedAt: number; enteredAt?: number }
interface ScopedReadOptions { after?: { at: number; key: string }; exclude?: DerivedSet }

/** Serialized values prevent an unwritten object mutation from changing cached state. */
class HotCache {
  private entries = new Map<string, CacheEntry>()
  private bytes = 0
  constructor(private limit: number) {}
  get size() { return this.entries.size }
  get(key: string) {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }
  set(key: string, value: string) {
    this.delete(key)
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(value)
    if (!this.limit || bytes > HOT_BYTES) return
    this.entries.set(key, { value, bytes })
    this.bytes += bytes
    while (this.entries.size > this.limit || this.bytes > HOT_BYTES) this.delete(this.entries.keys().next().value!)
  }
  delete(key: string) {
    const entry = this.entries.get(key)
    if (entry) { this.bytes -= entry.bytes; this.entries.delete(key) }
  }
  clear() { this.entries.clear(); this.bytes = 0 }
}

/** A bounded read cache over exact disk values. Persist mutations with set(). */
export class DerivedMap<T> implements Iterable<[string, T]>, CacheOwner {
  private cache: HotCache
  private dropped = false
  constructor(private index: AssistantDeskDerivedIndex, readonly storageKey: string, limit: number, private options: DerivedMapOptions) {
    this.cache = new HotCache(limit)
  }
  private check() { if (this.dropped) throw new Error('Derived namespace has been dropped') }
  get size() { this.check(); return this.index.count(this.storageKey) }
  get hotSize() { return this.cache.size }
  get(key: string): T | undefined {
    this.check()
    const value = this.cache.get(key) ?? this.index.read(this.storageKey, key)
    if (value === undefined) return undefined
    this.cache.set(key, value)
    return JSON.parse(value) as T
  }
  has(key: string) { this.check(); return this.cache.get(key) !== undefined || this.index.contains(this.storageKey, key) }
  set(key: string, value: T, scope?: DerivedScope): this {
    this.check()
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new TypeError('Derived values must be JSON serializable')
    const audience = this.options.audience ? value as AudienceValue : undefined
    const rowAccount = this.options.rows ? (value as { accountId?: string })?.accountId : undefined
    const accountId = typeof rowAccount === 'string' ? rowAccount : typeof audience?.accountIds?.[0] === 'string' ? audience.accountIds[0] : null
    const lastSeen = typeof audience?.lastSeenAt === 'number' && Number.isFinite(audience.lastSeenAt) ? audience.lastSeenAt : null
    this.index.write(this.storageKey, key, serialized, accountId, lastSeen, scope)
    this.cache.set(key, serialized)
    return this
  }
  delete(key: string) { this.check(); const removed = this.index.remove(this.storageKey, key); this.cache.delete(key); return removed }
  *entries(): IterableIterator<[string, T]> {
    this.check()
    for (const [key, value] of this.index.iterate(this.storageKey)) yield [key, JSON.parse(value) as T]
  }
  *keys(): IterableIterator<string> { for (const [key] of this.entries()) yield key }
  *values(): IterableIterator<T> { for (const [, value] of this.entries()) yield value }
  *valuesInSession(sessionId: string, from: number, to: number, after?: { at: number; key: string }): IterableIterator<T> {
    this.check()
    for (const [, value] of this.index.iterateScoped(this.storageKey, sessionId, from, to, -Number.MAX_VALUE, Number.MAX_VALUE, after)) yield JSON.parse(value) as T
  }
  configureWindow(sessionId: string, startedAt: number, seconds: number) { this.check(); this.index.configureWindow(this.storageKey, sessionId, startedAt, seconds) }
  windowCounts(sessionId: string, beforeIndex: number, limit = 50) { this.check(); return this.index.windowCounts(this.storageKey, sessionId, beforeIndex, undefined, '', limit) }
  rowPage(filter: RowPageFilter): T[] { this.check(); return this.index.rowPage(this.storageKey, filter).map(value => JSON.parse(value) as T) }
  latestReceivedAt(sessionId: string, from: number, to: number) { this.check(); return this.index.latestReceivedAt(this.storageKey, sessionId, from, to) }
  [Symbol.iterator]() { return this.entries() }
  clearCache() { this.cache.clear() }
  drop() { this.check(); this.index.drop(this.storageKey); this.dropped = true }
}

/** Exact receipts stay on disk after their bounded hot membership cache evicts them. */
export class DerivedSet implements Iterable<string>, CacheOwner {
  private cache: HotCache
  private dropped = false
  constructor(private index: AssistantDeskDerivedIndex, readonly storageKey: string, limit: number) { this.cache = new HotCache(limit) }
  private check() { if (this.dropped) throw new Error('Derived namespace has been dropped') }
  get size() { this.check(); return this.index.count(this.storageKey) }
  get hotSize() { return this.cache.size }
  has(key: string) {
    this.check()
    if (this.cache.get(key) !== undefined) return true
    if (!this.index.contains(this.storageKey, key)) return false
    this.cache.set(key, '1')
    return true
  }
  add(key: string, scope?: DerivedScope): this { this.check(); this.index.write(this.storageKey, key, '1', null, null, scope); this.cache.set(key, '1'); return this }
  delete(key: string) { this.check(); const removed = this.index.remove(this.storageKey, key); this.cache.delete(key); return removed }
  *values(): IterableIterator<string> { this.check(); for (const [key] of this.index.iterate(this.storageKey)) yield key }
  keys() { return this.values() }
  *keysInSession(sessionId: string, from: number, to: number, enteredFrom = -Number.MAX_VALUE, enteredTo = Number.MAX_VALUE, options?: ScopedReadOptions): IterableIterator<string> {
    this.check()
    for (const [key] of this.index.iterateScoped(this.storageKey, sessionId, from, to, enteredFrom, enteredTo, options?.after, options?.exclude?.storageKey)) yield key
  }
  configureWindow(sessionId: string, startedAt: number, seconds: number) { this.check(); this.index.configureWindow(this.storageKey, sessionId, startedAt, seconds) }
  windowCounts(sessionId: string, beforeIndex: number, partial?: { index: number; from: number; to: number }, exclude?: DerivedSet) {
    this.check(); return this.index.windowCounts(this.storageKey, sessionId, beforeIndex, partial, exclude?.storageKey)
  }
  [Symbol.iterator]() { return this.values() }
  clearCache() { this.cache.clear() }
  drop() { this.check(); this.index.drop(this.storageKey); this.dropped = true }
}

/** Rebuildable SQLite indexes; the append-only journal remains the source of truth. */
export class AssistantDeskDerivedIndex {
  private db: DatabaseSync
  private filename: string
  private adapters = new Map<string, CacheOwner>()
  private closed = false
  private replaying = false
  private depth = 0
  private savepoint = 0
  private readStatement: StatementSync
  private containsStatement: StatementSync
  private writeStatement: StatementSync
  private deleteStatement: StatementSync
  private countStatement: StatementSync
  private firstPageStatement: StatementSync
  private nextPageStatement: StatementSync
  private recentStatement: StatementSync
  private dropStatement: StatementSync
  private dropCountStatement: StatementSync
  private firstScopedStatement: StatementSync
  private nextScopedStatement: StatementSync
  private windowSettingStatement: StatementSync
  private saveWindowSettingStatement: StatementSync
  private rebuildWindowsStatement: StatementSync
  private windowCountsStatement: StatementSync
  private partialWindowStatement: StatementSync

  constructor(folder: string, options: { filename?: string; memory?: boolean } = {}) {
    const basename = options.filename ?? `assistant-derived-${randomUUID()}.sqlite`
    if (!/^[a-zA-Z0-9_.-]+\.sqlite$/.test(basename)) throw new Error('Invalid derived index filename')
    const directory = join(folder, 'derived')
    if (!options.memory) mkdirSync(directory, { recursive: true })
    this.filename = options.memory ? ':memory:' : join(directory, basename)
    this.db = new DatabaseSync(this.filename)
    // Deterministic Unicode case normalization is shared with the request validator.
    // Only a disposable index key changes; the captured JSON remains exact.
    this.db.function('assistant_history_handle', { deterministic: true }, value => normalizeAssistantHistoryHandle(value) ?? null)
    // The journal is written before apply and replays this disposable database at startup.
    // Keep SQL rollback, but avoid redundant durable checkpoints in an instance-owned file.
    this.db.exec(`
      PRAGMA cache_size = -8192;
      PRAGMA temp_store = ${options.memory ? 'MEMORY' : 'FILE'};
      PRAGMA mmap_size = 0;
      PRAGMA journal_mode = ${options.memory ? 'MEMORY' : 'WAL'};
      PRAGMA synchronous = OFF;
      PRAGMA locking_mode = EXCLUSIVE;
      PRAGMA wal_autocheckpoint = 256;
      PRAGMA journal_size_limit = 8388608;
      CREATE TABLE IF NOT EXISTS derived_values (
        namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        account_id TEXT, last_seen REAL, session_id TEXT, received_at REAL, entered_at REAL, window_index INTEGER,
        PRIMARY KEY(namespace, key)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS recent_audiences ON derived_values(namespace, account_id, last_seen DESC, key);
      CREATE TABLE IF NOT EXISTS derived_counts (namespace TEXT PRIMARY KEY, total INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TRIGGER IF NOT EXISTS derived_insert_count AFTER INSERT ON derived_values BEGIN
        INSERT INTO derived_counts(namespace, total) VALUES(NEW.namespace, 1)
        ON CONFLICT(namespace) DO UPDATE SET total = total + 1;
      END;
      CREATE TRIGGER IF NOT EXISTS derived_delete_count AFTER DELETE ON derived_values BEGIN
        UPDATE derived_counts SET total = total - 1 WHERE namespace = OLD.namespace;
      END;
    `)
    // Explicitly reopened disposable indexes can predate the scoped columns.
    const columns = new Set(this.db.prepare('PRAGMA table_info(derived_values)').all().map(row => row.name))
    for (const [name, type] of [['session_id', 'TEXT'], ['received_at', 'REAL'], ['entered_at', 'REAL'], ['window_index', 'INTEGER']])
      if (!columns.has(name)) this.db.exec(`ALTER TABLE derived_values ADD COLUMN ${name} ${type}`)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS scoped_receives ON derived_values(namespace, session_id, received_at, key) WHERE session_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS scoped_entries ON derived_values(namespace, session_id, entered_at, key) WHERE entered_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS archive_rows_recent ON derived_values(namespace, account_id, received_at DESC, key DESC) WHERE account_id IS NOT NULL AND received_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS archive_rows_handle ON derived_values(namespace, account_id, assistant_history_handle(json_extract(value, '$.mentionHandle')), received_at DESC, key DESC) WHERE account_id IS NOT NULL AND received_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS archive_rows_nickname ON derived_values(namespace, account_id, json_extract(value, '$.nickname'), received_at DESC, key DESC) WHERE account_id IS NOT NULL AND received_at IS NOT NULL;
      CREATE TABLE IF NOT EXISTS derived_window_settings (
        namespace TEXT NOT NULL, session_id TEXT NOT NULL, started_at REAL NOT NULL, interval_seconds INTEGER NOT NULL,
        PRIMARY KEY(namespace, session_id)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS derived_window_counts (
        namespace TEXT NOT NULL, session_id TEXT NOT NULL, window_index INTEGER NOT NULL, total INTEGER NOT NULL,
        PRIMARY KEY(namespace, session_id, window_index)
      ) WITHOUT ROWID;
      CREATE TRIGGER IF NOT EXISTS derived_insert_window AFTER INSERT ON derived_values WHEN NEW.window_index IS NOT NULL BEGIN
        INSERT INTO derived_window_counts VALUES(NEW.namespace, NEW.session_id, NEW.window_index, 1)
        ON CONFLICT(namespace, session_id, window_index) DO UPDATE SET total = total + 1;
      END;
      CREATE TRIGGER IF NOT EXISTS derived_delete_window AFTER DELETE ON derived_values WHEN OLD.window_index IS NOT NULL BEGIN
        UPDATE derived_window_counts SET total = total - 1 WHERE namespace = OLD.namespace AND session_id = OLD.session_id AND window_index = OLD.window_index;
        DELETE FROM derived_window_counts WHERE namespace = OLD.namespace AND session_id = OLD.session_id AND window_index = OLD.window_index AND total = 0;
      END;
      CREATE TRIGGER IF NOT EXISTS derived_update_window AFTER UPDATE ON derived_values
      WHEN OLD.session_id IS NOT NEW.session_id OR OLD.window_index IS NOT NEW.window_index BEGIN
        UPDATE derived_window_counts SET total = total - 1 WHERE namespace = OLD.namespace AND session_id = OLD.session_id AND window_index = OLD.window_index;
        DELETE FROM derived_window_counts WHERE namespace = OLD.namespace AND session_id = OLD.session_id AND window_index = OLD.window_index AND total = 0;
        INSERT INTO derived_window_counts SELECT NEW.namespace, NEW.session_id, NEW.window_index, 1 WHERE NEW.window_index IS NOT NULL
        ON CONFLICT(namespace, session_id, window_index) DO UPDATE SET total = total + 1;
      END;
    `)
    this.readStatement = this.db.prepare('SELECT value FROM derived_values WHERE namespace = ? AND key = ?')
    this.containsStatement = this.db.prepare('SELECT 1 FROM derived_values WHERE namespace = ? AND key = ?')
    // Repeated state classification can revisit unchanged membership. Preserve
    // metadata-only moves, but do not dirty indexes/WAL for an identical snapshot.
    this.writeStatement = this.db.prepare(`INSERT INTO derived_values(namespace,key,value,account_id,last_seen,session_id,received_at,entered_at,window_index) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value,account_id=excluded.account_id,last_seen=excluded.last_seen,session_id=excluded.session_id,received_at=excluded.received_at,entered_at=excluded.entered_at,window_index=excluded.window_index
      WHERE derived_values.value IS NOT excluded.value OR derived_values.account_id IS NOT excluded.account_id OR derived_values.last_seen IS NOT excluded.last_seen
        OR derived_values.session_id IS NOT excluded.session_id OR derived_values.received_at IS NOT excluded.received_at OR derived_values.entered_at IS NOT excluded.entered_at OR derived_values.window_index IS NOT excluded.window_index`)
    this.deleteStatement = this.db.prepare('DELETE FROM derived_values WHERE namespace = ? AND key = ?')
    this.countStatement = this.db.prepare('SELECT total FROM derived_counts WHERE namespace = ?')
    this.firstPageStatement = this.db.prepare('SELECT key,value FROM derived_values WHERE namespace = ? ORDER BY key LIMIT 128')
    this.nextPageStatement = this.db.prepare('SELECT key,value FROM derived_values WHERE namespace = ? AND key > ? ORDER BY key LIMIT 128')
    this.recentStatement = this.db.prepare('SELECT value FROM derived_values WHERE namespace = ? AND account_id = ? ORDER BY last_seen DESC,key LIMIT ?')
    this.dropStatement = this.db.prepare('DELETE FROM derived_values WHERE namespace = ?')
    this.dropCountStatement = this.db.prepare('DELETE FROM derived_counts WHERE namespace = ?')
    const scopedWhere = 'namespace = ? AND session_id = ? AND received_at >= ? AND received_at <= ? AND (entered_at IS NULL OR (entered_at >= ? AND entered_at < ?)) AND NOT EXISTS (SELECT 1 FROM derived_values excluded WHERE excluded.namespace = ? AND excluded.key = derived_values.key AND excluded.session_id = ?)'
    this.firstScopedStatement = this.db.prepare(`SELECT key,value,received_at FROM derived_values WHERE ${scopedWhere} ORDER BY received_at,key LIMIT 128`)
    this.nextScopedStatement = this.db.prepare(`SELECT key,value,received_at FROM derived_values WHERE ${scopedWhere} AND (received_at,key) > (?,?) ORDER BY received_at,key LIMIT 128`)
    this.windowSettingStatement = this.db.prepare('SELECT started_at,interval_seconds FROM derived_window_settings WHERE namespace = ? AND session_id = ?')
    this.saveWindowSettingStatement = this.db.prepare('INSERT INTO derived_window_settings VALUES(?,?,?,?) ON CONFLICT(namespace,session_id) DO UPDATE SET started_at=excluded.started_at,interval_seconds=excluded.interval_seconds')
    this.rebuildWindowsStatement = this.db.prepare('UPDATE derived_values SET window_index = CAST(MAX(0,entered_at - ?)/? AS INTEGER) WHERE namespace = ? AND session_id = ? AND entered_at IS NOT NULL AND window_index IS NOT CAST(MAX(0,entered_at - ?)/? AS INTEGER)')
    this.windowCountsStatement = this.db.prepare('SELECT counts.window_index,counts.total - COALESCE(excluded.total,0) AS total FROM derived_window_counts counts LEFT JOIN derived_window_counts excluded ON excluded.namespace = ? AND excluded.session_id = counts.session_id AND excluded.window_index = counts.window_index WHERE counts.namespace = ? AND counts.session_id = ? AND counts.window_index < ? AND counts.total > COALESCE(excluded.total,0) ORDER BY counts.window_index DESC LIMIT ?')
    this.partialWindowStatement = this.db.prepare('SELECT COUNT(*) AS total FROM derived_values WHERE namespace = ? AND session_id = ? AND entered_at >= ? AND entered_at <= ? AND NOT EXISTS (SELECT 1 FROM derived_values excluded WHERE excluded.namespace = ? AND excluded.key = derived_values.key AND excluded.session_id = ?)')
  }
  private check() { if (this.closed) throw new Error('Derived index is closed') }
  private storageKey(kind: string, namespace: string) {
    if (!namespace || namespace.length > 512) throw new Error('Invalid derived namespace')
    return JSON.stringify([kind, namespace])
  }
  private hotLimit(limit: number) { return Number.isFinite(limit) ? Math.max(0, Math.min(MAX_HOT_LIMIT, Math.floor(limit))) : DEFAULT_HOT_LIMIT }
  map<T>(namespace: string, limit = DEFAULT_HOT_LIMIT, options: DerivedMapOptions = {}): DerivedMap<T> {
    this.check()
    const key = this.storageKey('map', namespace), existing = this.adapters.get(key)
    if (existing) return existing as DerivedMap<T>
    const adapter = new DerivedMap<T>(this, key, this.hotLimit(limit), options)
    this.adapters.set(key, adapter)
    return adapter
  }
  set(namespace: string, limit = DEFAULT_HOT_LIMIT): DerivedSet {
    this.check()
    const key = this.storageKey('set', namespace), existing = this.adapters.get(key)
    if (existing) return existing as DerivedSet
    const adapter = new DerivedSet(this, key, this.hotLimit(limit))
    this.adapters.set(key, adapter)
    return adapter
  }
  read(namespace: string, key: string) { this.check(); return this.readStatement.get(namespace, key)?.value as string | undefined }
  contains(namespace: string, key: string) { this.check(); return this.containsStatement.get(namespace, key) !== undefined }
  write(namespace: string, key: string, value: string, accountId: string | null, lastSeen: number | null, scope?: DerivedScope) {
    this.check()
    const setting = scope?.enteredAt === undefined ? undefined : this.windowSettingStatement.get(namespace, scope.sessionId)
    const windowIndex = setting ? Math.floor(Math.max(0, scope!.enteredAt! - Number(setting.started_at)) / (Number(setting.interval_seconds) * 1000)) : null
    this.writeStatement.run(namespace, key, value, accountId, lastSeen, scope?.sessionId ?? null, scope?.receivedAt ?? null, scope?.enteredAt ?? null, windowIndex)
  }
  remove(namespace: string, key: string) { this.check(); return Number(this.deleteStatement.run(namespace, key).changes) > 0 }
  count(namespace: string) { this.check(); return Number(this.countStatement.get(namespace)?.total ?? 0) }
  *iterate(namespace: string): IterableIterator<[string, string]> {
    let lastKey: string | undefined
    while (true) {
      this.check()
      // Each bounded page releases its SQL cursor before a consumer can await or iterate another namespace.
      const page = lastKey === undefined ? this.firstPageStatement.all(namespace) : this.nextPageStatement.all(namespace, lastKey)
      if (!page.length) return
      for (const row of page) { lastKey = row.key as string; yield [lastKey, row.value as string] }
      if (page.length < 128) return
    }
  }
  *iterateScoped(namespace: string, sessionId: string, from: number, to: number, enteredFrom = -Number.MAX_VALUE, enteredTo = Number.MAX_VALUE, after?: { at: number; key: string }, excludedNamespace = ''): IterableIterator<[string, string]> {
    let last = after
    while (true) {
      this.check()
      const args = [namespace, sessionId, from, to, enteredFrom, enteredTo, excludedNamespace, sessionId]
      const page = last ? this.nextScopedStatement.all(...args, last.at, last.key) : this.firstScopedStatement.all(...args)
      if (!page.length) return
      for (const row of page) { last = { at: Number(row.received_at), key: row.key as string }; yield [last.key, row.value as string] }
      if (page.length < 128) return
    }
  }
  configureWindow(namespace: string, sessionId: string, startedAt: number, seconds: number) {
    this.check()
    const setting = this.windowSettingStatement.get(namespace, sessionId)
    if (setting?.started_at === startedAt && setting.interval_seconds === seconds) return
    this.transaction(() => {
      this.saveWindowSettingStatement.run(namespace, sessionId, startedAt, seconds)
      this.rebuildWindowsStatement.run(startedAt, seconds * 1000, namespace, sessionId, startedAt, seconds * 1000)
    })
  }
  windowCounts(namespace: string, sessionId: string, beforeIndex: number, partial?: { index: number; from: number; to: number }, excludedNamespace = '', limit = 50) {
    this.check()
    const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)))
    return this.windowCountsStatement.all(excludedNamespace, namespace, sessionId, beforeIndex, boundedLimit + 1).map(row => ({ index: Number(row.window_index), total:
      partial?.index === Number(row.window_index) ? Number(this.partialWindowStatement.get(namespace, sessionId, partial.from, partial.to, excludedNamespace, sessionId)?.total ?? 0) : Number(row.total),
    })).filter(row => row.total > 0).slice(0, boundedLimit)
  }
  rowPage(namespace: string, filter: RowPageFilter): string[] {
    this.check()
    const where = ['namespace = ?', 'account_id = ?', 'received_at IS NOT NULL'], values: (string | number)[] = [namespace, filter.accountId]
    if (filter.sessionId !== undefined) { where.push('session_id = ?'); values.push(filter.sessionId) }
    if (filter.userId !== undefined) { where.push("json_extract(value, '$.userId') = ?"); values.push(filter.userId) }
    if (filter.audienceUuid !== undefined) { where.push("json_extract(value, '$.audienceUuid') = ?"); values.push(filter.audienceUuid) }
    if (filter.mentionHandle !== undefined) { where.push("assistant_history_handle(json_extract(value, '$.mentionHandle')) = ?"); values.push(filter.mentionHandle) }
    // Equality treats %, _ and backslash literally: no LIKE wildcard or SQL interpolation.
    if (filter.nickname !== undefined) { where.push("json_extract(value, '$.nickname') = ?"); values.push(filter.nickname) }
    if (filter.from !== undefined) { where.push('received_at >= ?'); values.push(filter.from) }
    if (filter.to !== undefined) { where.push('received_at <= ?'); values.push(filter.to) }
    if (filter.minPayLevel !== undefined) { where.push("json_type(value, '$.payLevel') IN ('integer','real') AND json_extract(value, '$.payLevel') >= ?"); values.push(filter.minPayLevel) }
    if (filter.before) { where.push('(received_at,key) < (?,?)'); values.push(filter.before.at, filter.before.key) }
    values.push(filter.limit)
    return this.db.prepare(`SELECT value FROM derived_values WHERE ${where.join(' AND ')} ORDER BY received_at DESC,key DESC LIMIT ?`).all(...values).map(row => row.value as string)
  }
  latestReceivedAt(namespace: string, sessionId: string, from: number, to: number): number | undefined {
    this.check()
    const row = this.db.prepare('SELECT received_at FROM derived_values WHERE namespace=? AND session_id=? AND received_at>=? AND received_at<=? ORDER BY received_at DESC,key DESC LIMIT 1').get(namespace, sessionId, from, to)
    return row ? Number(row.received_at) : undefined
  }
  recentAudiences<T>(accountId: string, limit = 200, namespace = 'audiences'): T[] {
    this.check()
    const size = Number.isFinite(limit) ? Math.max(0, Math.min(200, Math.floor(limit))) : 200
    const result: T[] = []
    for (const row of this.recentStatement.iterate(this.storageKey('map', namespace), accountId, size)) result.push(JSON.parse(row.value as string) as T)
    return result
  }
  drop(namespace: string) {
    this.transaction(() => {
      this.dropStatement.run(namespace); this.dropCountStatement.run(namespace)
      this.db.prepare('DELETE FROM derived_window_settings WHERE namespace = ?').run(namespace)
    })
    this.adapters.get(namespace)?.clearCache()
    this.adapters.delete(namespace)
  }
  private clearCaches() { for (const adapter of this.adapters.values()) adapter.clearCache() }
  reset() { this.check(); this.db.exec('DELETE FROM derived_values; DELETE FROM derived_counts; DELETE FROM derived_window_counts; DELETE FROM derived_window_settings;'); this.clearCaches() }
  beginReplay() {
    this.check()
    if (this.depth) throw new Error('Derived replay is already in a transaction')
    this.db.exec('BEGIN IMMEDIATE')
    this.depth = 1
    this.replaying = true
  }
  endReplay(commit = true) {
    this.check()
    if (!this.replaying || this.depth !== 1) throw new Error('Derived replay is not active')
    try { this.db.exec(commit ? 'COMMIT' : 'ROLLBACK') }
    finally { this.depth = 0; this.replaying = false; if (!commit) this.clearCaches() }
  }
  transaction<T>(callback: () => T): T {
    this.check()
    const nested = this.depth > 0, savepoint = `derived_${++this.savepoint}`
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE')
    this.depth++
    try {
      const value = callback()
      this.db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT')
      return value
    } catch (error) {
      this.db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK')
      this.clearCaches()
      throw error
    } finally { this.depth-- }
  }
  close(options: { remove?: boolean } = {}) {
    if (this.closed) return
    if (this.depth) { this.db.exec('ROLLBACK'); this.depth = 0; this.replaying = false }
    this.db.close()
    this.closed = true
    this.clearCaches()
    this.adapters.clear()
    if (this.filename !== ':memory:' && options.remove !== false) for (const suffix of ['', '-wal', '-shm']) rmSync(`${this.filename}${suffix}`, { force: true })
  }
}
