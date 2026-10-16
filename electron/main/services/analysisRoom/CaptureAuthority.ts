import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { lstat, open, opendir } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import type { CaptureDatabaseIdentity } from './CaptureStorage'
import { validateCaptureIdentity } from './CaptureWorkerProtocol'

export const AUTHORITY_INSPECTION_LIMITS = Object.freeze({ maxEntries: 4096, directoryBufferSize: 32, maxDepth: 8, maxMarkerBytes: 4096, maxHeaderBytes: 100 })
export interface CaptureAuthorityLayout { appDataRoot: string; legacySourceRoot: string; canonicalContainer: string; primary: string; marker: string; anchor: string }
export function captureAuthorityLayout(appDataRoot: string): CaptureAuthorityLayout {
  if (typeof appDataRoot !== 'string' || !isAbsolute(appDataRoot) || appDataRoot.includes('\0') || appDataRoot.length > 1024) fail('INVALID_PATH')
  const root = resolve(appDataRoot), canonicalContainer = join(root, 'analysis-sqlite')
  return { appDataRoot: root, legacySourceRoot: join(root, 'analysis'), canonicalContainer, primary: join(canonicalContainer, 'capture.sqlite'), marker: join(canonicalContainer, 'capture-authority.json'), anchor: join(root, 'analysis-capture-authority.json') }
}
export interface CaptureAuthorityInspection {
  state: 'fresh' | 'legacy' | 'candidate' | 'blocked'; reason: string; canAdmit: false; verificationRequired: boolean; initialMigrationRequired: boolean
  expectedIdentity?: CaptureDatabaseIdentity; authorityPairComplete: boolean
  evidence: { legacy: boolean | 'not-inspected'; primary: boolean; marker: boolean; anchor: boolean; wal: boolean; shm: boolean; staging: boolean; backups: boolean; otherCanonical: boolean }
  metrics: { visitedEntries: number; peakOpenDirectories: number; markerBytesRead: number; primaryHeaderBytesRead: number }
}
type Reason = 'INVALID_PATH' | 'LINK_REJECTED' | 'SOURCE_CHANGED' | 'INSPECTION_LIMIT' | 'ABORTED' | 'IO_UNAVAILABLE' |
  'INVALID_MARKER' | 'UNSUPPORTED_SCHEMA' | 'AUTHORITY_IDENTITY_MISMATCH' | 'PRIMARY_MISSING_WITH_AUTHORITY' |
  'PRIMARY_MISSING_WITH_BACKUP' | 'PRIMARY_MISSING_WITH_EVIDENCE' | 'EMPTY_PRIMARY' | 'INVALID_PRIMARY_HEADER' |
  'UNSUPPORTED_SQLITE_FORMAT'
class InspectionError extends Error { constructor(readonly code: Reason) { super(code) } }
function fail(code: Reason): never { throw new InspectionError(code) }
function same(a: BigIntStats, b: BigIntStats): boolean {
  return ['dev', 'ino', 'nlink', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs'].every(key => a[key as keyof BigIntStats] === b[key as keyof BigIntStats])
}
/** No SQL access. Existing roots/files are read through physical paths only. */
async function physical(path: string, kind: 'file' | 'directory'): Promise<BigIntStats | undefined> {
  const absolute = resolve(path), base = parse(absolute).root
  let current = base
  const parts = relative(base, absolute).split(sep).filter(Boolean)
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = join(current, parts[index])
    let stat: BigIntStats
    try { stat = await lstat(current, { bigint: true }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (stat.isSymbolicLink()) fail('LINK_REJECTED')
    if (index < parts.length - 1 || kind === 'directory') { if (!stat.isDirectory()) fail('INVALID_PATH') }
    else { if (!stat.isFile()) fail('INVALID_PATH'); if (stat.nlink !== 1n) fail('LINK_REJECTED') }
    if (index === parts.length - 1) return stat
  }
  return undefined
}
class Membership {
  private count = 0
  private sum = 0n
  private xor = 0n
  add(name: string, directory: boolean) {
    const value = BigInt('0x' + createHash('sha256').update(directory ? 'directory\0' : 'file\0').update(String(Buffer.byteLength(name))).update(':').update(name).digest('hex'))
    this.count++; this.sum = (this.sum + value) & ((1n << 256n) - 1n); this.xor ^= value
  }
  equals(other: Membership) { return this.count === other.count && this.sum === other.sum && this.xor === other.xor }
}
interface Marker extends CaptureDatabaseIdentity { activationState: 'staged' | 'active' }

/** Shadow classifier only. Nothing here grants SQL admissions or mutation authority. */
export async function inspectCaptureAuthority(options: { appDataRoot: string; signal?: AbortSignal }): Promise<CaptureAuthorityInspection> {
  const evidence: CaptureAuthorityInspection['evidence'] = { legacy: 'not-inspected', primary: false, marker: false, anchor: false, wal: false, shm: false, staging: false, backups: false, otherCanonical: false }
  const metrics: CaptureAuthorityInspection['metrics'] = { visitedEntries: 0, peakOpenDirectories: 0, markerBytesRead: 0, primaryHeaderBytesRead: 0 }
  let openDirectories = 0, pair = false, expectedIdentity: CaptureDatabaseIdentity | undefined
  const knownPaths: Array<{ path: string; kind: 'file' | 'directory'; stat?: BigIntStats }> = []
  const result = (state: CaptureAuthorityInspection['state'], reason: string): CaptureAuthorityInspection => ({ state, reason, canAdmit: false,
    verificationRequired: state === 'candidate', initialMigrationRequired: state === 'legacy', authorityPairComplete: pair,
    ...(expectedIdentity ? { expectedIdentity: { ...expectedIdentity } } : {}), evidence: { ...evidence }, metrics: { ...metrics } })
  const abort = () => { if (options?.signal?.aborted) fail('ABORTED') }
  const remember = async (path: string, kind: 'file' | 'directory') => {
    const stat = await physical(path, kind); knownPaths.push({ path, kind, stat }); return stat
  }
  const stableKnownPaths = async () => {
    for (const known of knownPaths) {
      abort(); const current = await physical(known.path, known.kind)
      if (!!current !== !!known.stat || current && known.stat && !same(current, known.stat)) fail('SOURCE_CHANGED')
    }
  }
  const visit = () => { abort(); if (metrics.visitedEntries >= AUTHORITY_INSPECTION_LIMITS.maxEntries) fail('INSPECTION_LIMIT'); metrics.visitedEntries++ }
  const directory = async (path: string) => {
    abort()
    const value = await physical(path, 'directory'); if (!value) fail('SOURCE_CHANGED')
    return value
  }
  const leaf = async (file: string) => {
    abort(); const stat = await lstat(file, { bigint: true })
    if (stat.isSymbolicLink()) fail('LINK_REJECTED')
    if (!stat.isDirectory() && !stat.isFile()) fail('INVALID_PATH')
    if (stat.isFile() && stat.nlink !== 1n) fail('LINK_REJECTED')
    return stat
  }
  const scan = async (path: string, callback?: (name: string, stat: BigIntStats) => Promise<void>) => {
    const member = new Membership(), before = await directory(path)
    const dir = await opendir(path, { bufferSize: AUTHORITY_INSPECTION_LIMITS.directoryBufferSize })
    metrics.peakOpenDirectories = Math.max(metrics.peakOpenDirectories, ++openDirectories)
    try {
      for (;;) {
        abort(); const entry = await dir.read(); if (!entry) break
        visit(); const stat = await leaf(join(path, entry.name)); member.add(entry.name, stat.isDirectory())
        await callback?.(entry.name, stat)
      }
    } finally { openDirectories--; await dir.close() }
    if (!same(before, await directory(path))) fail('SOURCE_CHANGED')
    return member
  }
  const readOwned = async (file: string, stat: BigIntStats, maximum: number, marker: boolean) => {
    abort()
    if (marker && stat.size > BigInt(maximum)) fail('INSPECTION_LIMIT')
    const handle = await open(file, 'r')
    try {
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile() || opened.nlink !== 1n || !same(stat, opened)) fail('SOURCE_CHANGED')
      const wanted = Number(stat.size < BigInt(maximum) ? stat.size : BigInt(maximum)), bytes = Buffer.alloc(wanted)
      let offset = 0
      while (offset < wanted) {
        abort(); const read = await handle.read(bytes, offset, wanted - offset, offset)
        if (!read.bytesRead) fail('SOURCE_CHANGED')
        offset += read.bytesRead
        if (marker) metrics.markerBytesRead += read.bytesRead; else metrics.primaryHeaderBytesRead += read.bytesRead
      }
      const after = await physical(file, 'file')
      if (!after || !same(stat, after) || !same(stat, await handle.stat({ bigint: true }))) fail('SOURCE_CHANGED')
      return bytes
    } finally { await handle.close() }
  }
  const marker = async (file: string): Promise<Marker | undefined> => {
    const stat = await remember(file, 'file'); if (!stat) return undefined
    const bytes = await readOwned(file, stat, AUTHORITY_INSPECTION_LIMITS.maxMarkerBytes, true)
    let value: any
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { fail('INVALID_MARKER') }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4 ||
      !['databaseId', 'schemaVersion', 'generation', 'activationState'].every(key => Object.hasOwn(value, key)) ||
      !['staged', 'active'].includes(value.activationState)) fail('INVALID_MARKER')
    if (typeof value.schemaVersion === 'number' && Number.isSafeInteger(value.schemaVersion) && value.schemaVersion > 1) fail('UNSUPPORTED_SCHEMA')
    try { return { ...validateCaptureIdentity({ databaseId: value.databaseId, generation: value.generation, schemaVersion: value.schemaVersion }), activationState: value.activationState } }
    catch { fail('INVALID_MARKER') }
  }
  try {
    abort(); const layout = captureAuthorityLayout(options?.appDataRoot)
    await remember(layout.appDataRoot, 'directory')
    const canonical = await remember(layout.canonicalContainer, 'directory')
    const outside = await marker(layout.anchor), inside = await marker(layout.marker)
    evidence.anchor = !!outside; evidence.marker = !!inside
    if (outside && inside && (outside.databaseId !== inside.databaseId || outside.generation !== inside.generation || outside.schemaVersion !== inside.schemaVersion || outside.activationState !== inside.activationState)) fail('AUTHORITY_IDENTITY_MISMATCH')
    pair = !!outside && !!inside
    const declared = outside ?? inside
    if (declared) expectedIdentity = { databaseId: declared.databaseId, schemaVersion: 1, generation: declared.generation }
    const primary = await remember(layout.primary, 'file')
    evidence.primary = !!primary
    evidence.wal = !!await remember(layout.primary + '-wal', 'file')
    evidence.shm = !!await remember(layout.primary + '-shm', 'file')
    const walk = async (path: string, depth: number): Promise<void> => {
      if (depth > AUTHORITY_INSPECTION_LIMITS.maxDepth) fail('INSPECTION_LIMIT')
      const before = await scan(path)
      const observed = await scan(path, async (name, stat) => {
        const file = join(path, name), token = relative(layout.canonicalContainer, file).split(sep).join('/')
        if (token === 'capture.sqlite') evidence.primary = true
        else if (token === 'capture.sqlite-wal') evidence.wal = true
        else if (token === 'capture.sqlite-shm') evidence.shm = true
        else if (token === 'capture-authority.json') evidence.marker = true
        else if (token === 'backups' || token.startsWith('backups/')) evidence.backups = true
        else if (/^capture\.pending-[0-9a-f-]{36}\.sqlite(?:-wal|-shm)?$/i.test(token)) evidence.staging = true
        else evidence.otherCanonical = true
        if (stat.isDirectory()) await walk(file, depth + 1)
      })
      const after = await scan(path)
      if (!before.equals(observed) || !before.equals(after)) fail('SOURCE_CHANGED')
    }
    if (canonical) await walk(layout.canonicalContainer, 0)
    await stableKnownPaths()
    if (!primary) {
      if (inside || outside) fail('PRIMARY_MISSING_WITH_AUTHORITY')
      if (evidence.backups) fail('PRIMARY_MISSING_WITH_BACKUP')
      if (evidence.wal || evidence.shm || evidence.staging || evidence.otherCanonical) fail('PRIMARY_MISSING_WITH_EVIDENCE')
      // Only the initial/fresh path observes legacy. A SQL candidate remains
      // independent of old-tree readability or size.
      const legacy = await remember(layout.legacySourceRoot, 'directory')
      const hasLegacyEntry = async (): Promise<boolean> => {
        if (!legacy) return false
        if (!same(legacy, await directory(layout.legacySourceRoot))) fail('SOURCE_CHANGED')
        const dir = await opendir(layout.legacySourceRoot, { bufferSize: AUTHORITY_INSPECTION_LIMITS.directoryBufferSize })
        metrics.peakOpenDirectories = Math.max(metrics.peakOpenDirectories, ++openDirectories)
        let present = false
        try {
          abort(); const entry = await dir.read()
          if (entry) { visit(); await leaf(join(layout.legacySourceRoot, entry.name)); present = true }
        } finally { openDirectories--; await dir.close() }
        if (!same(legacy, await directory(layout.legacySourceRoot))) fail('SOURCE_CHANGED')
        return present
      }
      evidence.legacy = await hasLegacyEntry()
      const current = await physical(layout.canonicalContainer, 'directory')
      if (!!current !== !!canonical || canonical && current && !same(current, canonical)) fail('SOURCE_CHANGED')
      await stableKnownPaths()
      if (!evidence.legacy) {
        // Cached directory metadata cannot establish empty membership. Probe
        // the first entry again before publishing fresh, without scanning facts.
        if (await hasLegacyEntry()) fail('SOURCE_CHANGED')
        await stableKnownPaths()
      }
      return evidence.legacy ? result('legacy', 'EXPLICIT_INITIAL_MIGRATION_REQUIRED') : result('fresh', 'NO_AUTHORITY_OR_HISTORY_EVIDENCE')
    }
    if (primary.size === 0n) fail('EMPTY_PRIMARY')
    const header = await readOwned(layout.primary, primary, AUTHORITY_INSPECTION_LIMITS.maxHeaderBytes, false)
    if (header.length !== 100 || !header.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) fail('INVALID_PRIMARY_HEADER')
    const encoded = header.readUInt16BE(16), pageSize = encoded === 1 ? 65536 : encoded
    if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0 || primary.size < BigInt(pageSize) || primary.size % BigInt(pageSize) !== 0n) fail('INVALID_PRIMARY_HEADER')
    if (![1, 2].includes(header[18]) || ![1, 2].includes(header[19]) || header.readUInt32BE(44) > 4 || header.readUInt32BE(56) > 3) fail('UNSUPPORTED_SQLITE_FORMAT')
    // The actual foundation schema lives in database_meta, not user_version.
    // SQL identity, typed completion and all integrity checks remain unread.
    await stableKnownPaths()
    return result('candidate', pair ? 'SQL_VERIFICATION_REQUIRED' : 'INCOMPLETE_AUTHORITY')
  } catch (error) {
    return result('blocked', error instanceof InspectionError ? error.code : (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'SOURCE_CHANGED' : 'IO_UNAVAILABLE')
  }
}
