import { closeSync, existsSync, lstatSync, openSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { analysisId, analysisInteger } from '../../../../shared/analysisRoom'
import type { CaptureDatabaseIdentity } from './CaptureStorage'
import { initializeCaptureSchema } from './CaptureDatabaseSchema'
import { inventoryLegacySources, readLegacySource, type LegacySourceEntry } from './CaptureLegacyReader'

/** Private physical evidence staging only; no typed fact or authority publication. */
export interface LegacyStageResult {
  status: 'verified'
  databaseId: string
  sourceCount: number
  sourceBytes: number
  verifiedSourceCount: number
  copiedBytes: number
  lineCount: number
  rejectedLines: number
  warningSamples: Array<{ sourceId: number; line: number; byteOffset: number; code: string }>
  activationAllowed: false
  maxBatchRows: number
  maxBatchBytes: number
  maxRetainedChunkBytes: number
}
interface StageOptions {
  root: string
  staging: string
  identity: CaptureDatabaseIdentity
  mode: 'create' | 'resume'
  signal?: AbortSignal
  /** A post-commit ceiling: failure preserves the last bounded batch as evidence. */
  maxStagingBytes?: number
  onCheckpoint?: (value: { copiedBytes: number; sourceCount: number }) => void | Promise<void>
}
export class CaptureMigrationError extends Error {
  constructor(readonly code: string) { super(code) }
}
const fail = (code: string): never => { throw new CaptureMigrationError(code) }
const LIMIT_BYTES = 1024 * 1024
const LIMIT_ROWS = 128
const SOURCE_LIMIT = 5 * 1024 ** 3
const DEFAULT_PHYSICAL = 10 * 1024 ** 3
const STAGE_SCHEMA = `
CREATE TABLE legacy_import_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
CREATE TABLE legacy_sources(
 id INTEGER PRIMARY KEY,relative_path TEXT NOT NULL UNIQUE,size INTEGER NOT NULL,sha256 TEXT NOT NULL,
 fingerprint TEXT NOT NULL,verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN(0,1))
) STRICT;
CREATE TABLE legacy_chunks(
 source_id INTEGER NOT NULL,offset INTEGER NOT NULL,next_offset INTEGER NOT NULL,bytes BLOB NOT NULL,
 PRIMARY KEY(source_id,offset),FOREIGN KEY(source_id) REFERENCES legacy_sources(id),
 CHECK(offset>=0 AND next_offset>offset AND length(bytes)=next_offset-offset AND length(bytes)<=65536)
) STRICT;
CREATE TABLE legacy_lines(
 source_id INTEGER NOT NULL,line INTEGER NOT NULL,start_offset INTEGER NOT NULL,next_offset INTEGER NOT NULL,
 status TEXT NOT NULL,issues TEXT NOT NULL,
 PRIMARY KEY(source_id,line),FOREIGN KEY(source_id) REFERENCES legacy_sources(id)
) STRICT;
CREATE TRIGGER legacy_sources_no_identity_update BEFORE UPDATE ON legacy_sources
WHEN OLD.id IS NOT NEW.id OR OLD.relative_path IS NOT NEW.relative_path OR OLD.size IS NOT NEW.size
 OR OLD.sha256 IS NOT NEW.sha256 OR OLD.fingerprint IS NOT NEW.fingerprint
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEGACY_SOURCE'); END;
CREATE TRIGGER legacy_sources_no_delete BEFORE DELETE ON legacy_sources BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEGACY_SOURCE'); END;
CREATE TRIGGER legacy_chunks_no_update BEFORE UPDATE ON legacy_chunks BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEGACY_CHUNK'); END;
CREATE TRIGGER legacy_chunks_no_delete BEFORE DELETE ON legacy_chunks BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEGACY_CHUNK'); END;
CREATE TRIGGER legacy_lines_no_update BEFORE UPDATE ON legacy_lines BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEGACY_LINE'); END;
CREATE TRIGGER legacy_lines_no_delete BEFORE DELETE ON legacy_lines BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEGACY_LINE'); END;
`
function checkAbort(signal?: AbortSignal) { if (signal?.aborted) fail('ABORTED') }
function physicalAncestors(path: string) {
  let current = resolve(path)
  for (;;) {
    const value = lstatSync(current)
    if (value.isSymbolicLink() || !value.isDirectory()) fail('UNSAFE_STAGING')
    const parent = dirname(current); if (parent === current) return; current = parent
  }
}
function stagingPath(options: StageOptions) {
  if (!isAbsolute(options.root) || !isAbsolute(options.staging) || options.root.includes('\0') || options.staging.includes('\0')) fail('UNSAFE_STAGING')
  if (!['create', 'resume'].includes(options.mode)) fail('INVALID_STAGE_MODE')
  physicalAncestors(options.root); physicalAncestors(dirname(options.staging))
  const root = realpathSync(options.root), file = resolve(options.staging)
  const within = relative(root, join(realpathSync(dirname(file)), file.slice(dirname(file).length + 1)))
  if (!within || !isAbsolute(within) && within !== '..' && !within.startsWith(`..${sep}`)) fail('UNSAFE_STAGING')
  if (!/^capture\.pending-[0-9a-f-]{36}\.sqlite$/i.test(file.slice(dirname(file).length + 1))) fail('UNSAFE_STAGING')
  if (options.mode === 'create') {
    if (existsSync(file) || existsSync(file + '-wal') || existsSync(file + '-shm')) fail('STAGING_EXISTS')
    const fd = openSync(file, 'wx'); closeSync(fd)
  } else {
    if (!existsSync(file)) fail('STAGING_MISSING')
    const stat = lstatSync(file)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) fail('UNSAFE_STAGING')
  }
  return { root, file }
}
function footprint(file: string) {
  let total = 0
  for (const name of [file, file + '-wal', file + '-shm']) {
    try { const stat = lstatSync(name); if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) fail('UNSAFE_STAGING'); total += stat.size }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return total
}
/** Must execute before DatabaseSync can open/map a pre-existing WAL or SHM. */
function guardStageFamily(file: string) { footprint(file) }
function fingerprint(entry: LegacySourceEntry) {
  return JSON.stringify({ identity: entry.identity, rootIdentity: entry.rootIdentity })
}
function meta(db: DatabaseSync, key: string) { return db.prepare('SELECT value FROM legacy_import_meta WHERE key=?').get(key)?.value as string | undefined }
function saveMeta(db: DatabaseSync, key: string, value: string) { db.prepare('INSERT INTO legacy_import_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value) }
function validateStageSchema(db: DatabaseSync) {
  const definitions = [...(STAGE_SCHEMA.match(/CREATE TABLE [^;]+;/g) ?? []), ...(STAGE_SCHEMA.match(/CREATE TRIGGER [\s\S]*? END;/g) ?? [])]
  const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim().replace(/;$/, '')
  const statement = db.prepare('SELECT sql FROM sqlite_master WHERE name=? AND type=?')
  for (const sql of definitions) {
    const [, type, name] = sql.match(/^CREATE (TABLE|TRIGGER) (\w+)/)!
    const stored = statement.get(name, type.toLowerCase())
    if (!stored || normalize(String(stored.sql)) !== normalize(sql)) fail('INVALID_STAGE_SCHEMA')
  }
}
function matches(row: Record<string, unknown>, entry: LegacySourceEntry) {
  return row.relative_path === entry.relativePath && row.size === entry.size && row.sha256 === entry.sha256 && row.fingerprint === fingerprint(entry)
}

/**
 * All payloads remain private SQL BLOBs. A final verified stage is only a
 * byte-preservation proof; later typed validation and cutover are mandatory.
 * Source writers must be quiesced; this is not a hostile atomic-tree snapshot.
 */
export async function stageLegacyCapture(options: StageOptions): Promise<LegacyStageResult> {
  checkAbort(options.signal)
  if (!options.identity || options.identity.schemaVersion !== 1) fail('INVALID_STAGE_IDENTITY')
  analysisId(options.identity.databaseId); analysisInteger(options.identity.generation, 1)
  const physicalLimit = options.maxStagingBytes ?? DEFAULT_PHYSICAL
  if (!Number.isSafeInteger(physicalLimit) || physicalLimit < 1 || physicalLimit > DEFAULT_PHYSICAL) fail('INVALID_STAGE_LIMIT')
  const { root, file } = stagingPath(options)
  guardStageFamily(file)
  const initialStat = lstatSync(file)
  const ensureOwnedStorage = () => {
    physicalAncestors(dirname(file))
    const current = lstatSync(file)
    if (current.isSymbolicLink() || current.nlink !== 1 || current.dev !== initialStat.dev || current.ino !== initialStat.ino) fail('UNSAFE_STAGING')
    guardStageFamily(file)
  }
  let db: DatabaseSync | undefined, initialized = false, inTransaction = false
  let rows = 0, bytes = 0, maxBatchRows = 0, maxBatchBytes = 0, maxRetainedChunkBytes = 0
  try {
    db = new DatabaseSync(file)
    ensureOwnedStorage()
    initializeCaptureSchema(db, options.identity)
    if (options.mode === 'create') {
      db.exec('BEGIN IMMEDIATE'); inTransaction = true
      db.exec(STAGE_SCHEMA); saveMeta(db, 'version', '1'); saveMeta(db, 'root', root)
      saveMeta(db, 'inventory_complete', '0'); saveMeta(db, 'status', 'copying')
      db.exec('COMMIT'); inTransaction = false
    } else {
      validateStageSchema(db)
      if (meta(db, 'version') !== '1' || meta(db, 'root') !== root) fail('INVALID_STAGE_HEADER')
      const inventory = meta(db, 'inventory_complete'), status = meta(db, 'status'), copied = meta(db, 'copied_bytes')
      if (!['0', '1'].includes(inventory ?? '') || !['copying', 'failed', 'verified'].includes(status ?? '') || status === 'verified' && inventory !== '1') fail('INVALID_STAGE_HEADER')
      const heldBytes = Number(db.prepare('SELECT COALESCE(SUM(length(bytes)),0) AS n FROM legacy_chunks').get()!.n)
      if (copied === undefined ? heldBytes !== 0 || status === 'verified' : !/^(0|[1-9]\d*)$/.test(copied) || !Number.isSafeInteger(Number(copied)) || Number(copied) !== heldBytes) fail('INVALID_STAGE_HEADER')
    }
    initialized = true
    const database = db
    const checkPhysical = () => { ensureOwnedStorage(); if (footprint(file) > physicalLimit) fail('STAGING_LIMIT') }
    checkPhysical()
    saveMeta(database, 'status', 'copying')
    // No unbounded manifest array; an incomplete first inventory can resume its
    // exact stored prefix, while a complete inventory admits no added source.
    const inventoryWasComplete = meta(database, 'inventory_complete') === '1'
    const known = database.prepare('SELECT * FROM legacy_sources WHERE relative_path=?')
    const insertSource = database.prepare('INSERT INTO legacy_sources(relative_path,size,sha256,fingerprint) VALUES(?,?,?,?)')
    let sourceCount = 0, sourceBytes = 0
    for await (const entry of inventoryLegacySources(root, { signal: options.signal })) {
      checkAbort(options.signal); sourceCount++; sourceBytes += entry.size
      if (sourceBytes > SOURCE_LIMIT) fail('SOURCE_LIMIT')
      const stored = known.get(entry.relativePath)
      if (stored) { if (!matches(stored, entry)) fail('SOURCE_CHANGED') }
      else { if (inventoryWasComplete) fail('SOURCE_CHANGED'); ensureOwnedStorage(); insertSource.run(entry.relativePath, entry.size, entry.sha256, fingerprint(entry)) }
      if (sourceCount % 128 === 0) { checkPhysical(); await new Promise<void>(done => setImmediate(done)) }
    }
    if (Number(database.prepare('SELECT COUNT(*) AS n FROM legacy_sources').get()!.n) !== sourceCount) fail('SOURCE_CHANGED')
    saveMeta(database, 'inventory_complete', '1')
    let copiedBytes = Number(database.prepare('SELECT COALESCE(SUM(length(bytes)),0) AS n FROM legacy_chunks').get()!.n)
    const begin = () => { if (!inTransaction) { ensureOwnedStorage(); database.exec('BEGIN IMMEDIATE'); inTransaction = true } }
    const flush = async () => {
      if (!inTransaction) return
      ensureOwnedStorage()
      // Exact physical chunks and their resumable checkpoint publish together.
      saveMeta(database, 'copied_bytes', String(copiedBytes))
      database.exec('COMMIT'); inTransaction = false
      maxBatchRows = Math.max(maxBatchRows, rows); maxBatchBytes = Math.max(maxBatchBytes, bytes); rows = 0; bytes = 0
      checkPhysical(); await options.onCheckpoint?.({ copiedBytes, sourceCount })
      checkAbort(options.signal); await new Promise<void>(done => setImmediate(done))
    }
    const existingChunk = database.prepare('SELECT next_offset,bytes FROM legacy_chunks WHERE source_id=? AND offset=?')
    const insertChunk = database.prepare('INSERT INTO legacy_chunks VALUES(?,?,?,?)')
    const existingLine = database.prepare('SELECT start_offset,next_offset,status,issues FROM legacy_lines WHERE source_id=? AND line=?')
    const insertLine = database.prepare('INSERT INTO legacy_lines VALUES(?,?,?,?,?,?)')
    let lastId = 0
    for (;;) {
      const page = database.prepare('SELECT * FROM legacy_sources WHERE id>? ORDER BY id LIMIT 128').all(lastId)
      if (!page.length) break
      for (const source of page) {
        checkAbort(options.signal); const sourceId = Number(source.id); lastId = sourceId
        const details = JSON.parse(String(source.fingerprint)) as Pick<LegacySourceEntry, 'identity' | 'rootIdentity'>
        const entry: LegacySourceEntry = { ...details, relativePath: String(source.relative_path), size: Number(source.size), sha256: String(source.sha256),
          inventoryMetrics: { directoryBufferSize: 32, peakOpenDirectories: 0, peakOpenFiles: 0 } }
        let verified = false
        for await (const event of readLegacySource(root, entry, { signal: options.signal })) {
          if (event.kind === 'chunk') {
            maxRetainedChunkBytes = Math.max(maxRetainedChunkBytes, event.bytes.byteLength)
            if (rows === LIMIT_ROWS || bytes + event.bytes.byteLength > LIMIT_BYTES) await flush()
            const previous = existingChunk.get(sourceId, event.offset)
            if (previous) {
              if (previous.next_offset !== event.nextOffset || !Buffer.from(previous.bytes as Uint8Array).equals(event.bytes)) fail('STAGING_CONFLICT')
            } else {
              begin(); insertChunk.run(sourceId, event.offset, event.nextOffset, event.bytes); rows++; bytes += event.bytes.byteLength; copiedBytes += event.bytes.byteLength
            }
          } else if (event.kind === 'line') {
            if (rows === LIMIT_ROWS) await flush()
            const issues = JSON.stringify(event.issues), previous = existingLine.get(sourceId, event.line)
            if (previous) {
              if (previous.start_offset !== event.startOffset || previous.next_offset !== event.nextOffset || previous.status !== event.status || previous.issues !== issues) fail('STAGING_CONFLICT')
            } else { begin(); insertLine.run(sourceId, event.line, event.startOffset, event.nextOffset, event.status, issues); rows++ }
          } else {
            await flush(); checkAbort(options.signal)
            const heldBytes = Number(database.prepare('SELECT COALESCE(SUM(length(bytes)),0) AS n FROM legacy_chunks WHERE source_id=?').get(sourceId)!.n)
            const heldLines = Number(database.prepare('SELECT COUNT(*) AS n FROM legacy_lines WHERE source_id=?').get(sourceId)!.n)
            if (heldBytes !== event.size || heldLines !== event.metrics.lineCount) fail('STAGING_CONFLICT')
            ensureOwnedStorage()
            database.prepare('UPDATE legacy_sources SET verified=1 WHERE id=?').run(sourceId); verified = true
          }
        }
        if (!verified) fail('SOURCE_CHANGED')
      }
    }
    // Reinventory every source after staging, including files previously copied.
    // No exclusion wildcard or alternate recovery source is used.
    let finalCount = 0
    for await (const entry of inventoryLegacySources(root, { signal: options.signal })) {
      checkAbort(options.signal); finalCount++
      const stored = known.get(entry.relativePath); if (!stored || !matches(stored, entry)) fail('SOURCE_CHANGED')
    }
    if (finalCount !== sourceCount) fail('SOURCE_CHANGED')
    // An external connection can disable FK enforcement while inserting an
    // orphan. Bound the diagnostic result; do not silently include that row in
    // the global evidence counts or delete it as a repair.
    if (database.prepare('PRAGMA foreign_key_check').get()) fail('STAGING_CONFLICT')
    checkPhysical(); checkAbort(options.signal)
    database.exec('BEGIN IMMEDIATE'); inTransaction = true
    saveMeta(database, 'status', 'verified'); saveMeta(database, 'copied_bytes', String(copiedBytes))
    database.exec('COMMIT'); inTransaction = false
    checkPhysical()
    const count = (sql: string) => Number(database.prepare(sql).get()!.n)
    const warningSamples = database.prepare("SELECT source_id,line,start_offset,issues FROM legacy_lines WHERE status<>'valid' ORDER BY source_id,line LIMIT 1000").all().map(row => ({
      sourceId: Number(row.source_id), line: Number(row.line), byteOffset: Number(row.start_offset), code: String((JSON.parse(String(row.issues)) as string[])[0] ?? 'INVALID_LINE'),
    }))
    return { status: 'verified', databaseId: options.identity.databaseId, sourceCount, sourceBytes,
      verifiedSourceCount: count('SELECT COUNT(*) AS n FROM legacy_sources WHERE verified=1'), copiedBytes,
      lineCount: count('SELECT COUNT(*) AS n FROM legacy_lines'), rejectedLines: count("SELECT COUNT(*) AS n FROM legacy_lines WHERE status<>'valid'"),
      warningSamples, activationAllowed: false, maxBatchRows, maxBatchBytes, maxRetainedChunkBytes }
  } catch (error) {
    if (inTransaction) { try { db?.exec('ROLLBACK') } catch {} }
    // Unsafe family paths are never opened again for a failure marker. A caller
    // can inspect the retained artifact rather than have us write through aliases.
    if (initialized && (error as { code?: unknown })?.code !== 'UNSAFE_STAGING') { try { ensureOwnedStorage(); saveMeta(db!, 'status', 'failed') } catch {} }
    throw error
  } finally { db?.close() }
}
