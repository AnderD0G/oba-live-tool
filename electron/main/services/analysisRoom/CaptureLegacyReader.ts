import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep, win32 } from 'node:path'

type LegacyReadCode = 'UNSAFE_PATH' | 'LINK_REJECTED' | 'SOURCE_CHANGED' | 'READ_LIMIT' | 'SOURCE_TYPE' | 'ABORTED'
export class CaptureLegacyReadError extends Error {
  constructor(readonly code: LegacyReadCode, message: string, options?: ErrorOptions) {
    super(message, options); this.name = 'CaptureLegacyReadError'
  }
}
export interface LegacySourceIdentity {
  dev: string; ino: string; nlink: string; size: string
  mtimeNs: string; ctimeNs: string; birthtimeNs: string
}
export interface LegacySourceEntry {
  relativePath: string
  size: number
  sha256: string
  identity: LegacySourceIdentity
  rootIdentity: { dev: string; ino: string }
  inventoryMetrics: { directoryBufferSize: number; peakOpenDirectories: number; peakOpenFiles: number }
}
export type LegacyLineIssue = 'INVALID_UTF8' | 'LINE_TOO_LARGE' | 'MALFORMED_EOF'
export type LegacyReadEvent =
  | { kind: 'chunk'; offset: number; nextOffset: number; bytes: Uint8Array }
  | { kind: 'line'; line: number; startOffset: number; nextOffset: number; contentBytes: number;
      status: 'valid' | 'rejected'; issues: LegacyLineIssue[]; text?: string }
  | { kind: 'verified'; relativePath: string; size: number; sha256: string;
      metrics: { peakBufferedBytes: number; maxBufferedLineBytes: number; maxChunkBytes: number; readCalls: number; lineCount: number } }
interface InventoryOptions { signal?: AbortSignal; maxDepth?: number; directoryBufferSize?: number }
interface ReadOptions { signal?: AbortSignal; chunkBytes?: number; maxLineBytes?: number }
const MAX_CHUNK = 64 * 1024
const MAX_LINE = 128 * 1024
const MAX_PATH_BYTES = 4096
function fail(code: LegacyReadCode, message: string): never { throw new CaptureLegacyReadError(code, message) }
function bounded(value: number, min: number, max: number, label: string) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('READ_LIMIT', `invalid ${label}`)
  return value
}
function checkAbort(signal?: AbortSignal) { if (signal?.aborted) fail('ABORTED', 'legacy reading was cancelled') }
function contained(root: string, file: string) {
  const path = relative(root, file)
  if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) fail('UNSAFE_PATH', 'legacy path leaves its root')
}
function sourcePath(root: string, value: string) {
  if (typeof value !== 'string' || !value || value.includes('\0') || Buffer.byteLength(value) > MAX_PATH_BYTES ||
    isAbsolute(value) || win32.parse(value).root || value.includes('\\') ||
    value.split('/').some(part => !part || part === '.' || part === '..') ||
    (process.platform === 'win32' && value.includes(':')))
    fail('UNSAFE_PATH', 'invalid literal relative source path')
  const file = resolve(root, ...value.split('/'))
  contained(root, file)
  return file
}
function identity(stat: BigIntStats): LegacySourceIdentity {
  return { dev: stat.dev.toString(), ino: stat.ino.toString(), nlink: stat.nlink.toString(), size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(), birthtimeNs: stat.birthtimeNs.toString() }
}
function matches(a: LegacySourceIdentity, b: LegacySourceIdentity) {
  return (Object.keys(a) as Array<keyof LegacySourceIdentity>).every(key => a[key] === b[key])
}
function directory(stat: BigIntStats) {
  if (stat.isSymbolicLink()) fail('LINK_REJECTED', 'linked legacy directory is not admitted')
  if (!stat.isDirectory()) fail('SOURCE_TYPE', 'legacy directory must be a physical directory')
}
function regular(stat: BigIntStats) {
  if (stat.isSymbolicLink() || stat.nlink !== 1n) fail('LINK_REJECTED', 'linked legacy file is not admitted')
  if (!stat.isFile()) fail('SOURCE_TYPE', 'legacy source must be a regular physical file')
}
async function checkedRoot(input: string) {
  if (typeof input !== 'string' || !isAbsolute(input) || input.includes('\0')) fail('UNSAFE_PATH', 'legacy root must be absolute')
  const root = resolve(input), base = parse(root).root
  let path = base
  directory(await lstat(path, { bigint: true }))
  for (const part of relative(base, root).split(sep).filter(Boolean)) {
    path = join(path, part); directory(await lstat(path, { bigint: true }))
  }
  const physical = await realpath(root)
  return { path: physical, stat: await lstat(physical, { bigint: true }) }
}
async function safeStat(root: string, file: string, fileExpected: boolean) {
  contained(root, file)
  const parts = relative(root, file).split(sep).filter(Boolean)
  let current = root, stat = await lstat(root, { bigint: true })
  directory(stat)
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]); stat = await lstat(current, { bigint: true })
    if (index < parts.length - 1 || !fileExpected) directory(stat)
    else regular(stat)
  }
  contained(root, await realpath(file))
  return stat
}
function changed(a: LegacySourceIdentity, b: LegacySourceIdentity) {
  if (!matches(a, b)) fail('SOURCE_CHANGED', 'legacy source identity or metadata changed')
}
async function checkedFile(root: string, file: string, expected: LegacySourceIdentity) {
  changed(expected, identity(await safeStat(root, file, true)))
  const handle = await open(file, 'r')
  try {
    const stat = await handle.stat({ bigint: true }); regular(stat); changed(expected, identity(stat))
    changed(expected, identity(await safeStat(root, file, true)))
    return handle
  } catch (error) { await handle.close(); throw error }
}
async function unchangedFile(root: string, file: string, handle: Awaited<ReturnType<typeof open>>, expected: LegacySourceIdentity) {
  const stat = await handle.stat({ bigint: true }); regular(stat); changed(expected, identity(stat))
  changed(expected, identity(await safeStat(root, file, true)))
}

/** Order-independent bounded multiset; no directory-sized names array/cache. */
class DirectoryMembership {
  private count = 0
  private sum = 0n
  private xor = 0n
  add(name: string, stat: BigIntStats) {
    if (stat.isSymbolicLink()) fail('LINK_REJECTED', 'linked legacy entry is not admitted')
    const kind = stat.isDirectory() ? 'directory' : 'file'
    if (kind === 'file') regular(stat)
    if (!Number.isSafeInteger(++this.count)) fail('READ_LIMIT', 'legacy directory member count exceeded')
    const hash = createHash('sha256').update(kind).update('\0').update(String(Buffer.byteLength(name))).update(':').update(name).digest('hex')
    const digest = BigInt(`0x${hash}`)
    this.sum = (this.sum + digest) & ((1n << 256n) - 1n)
    this.xor ^= digest
  }
  equals(other: DirectoryMembership) { return this.count === other.count && this.sum === other.sum && this.xor === other.xor }
}

/** File hashes are per-file verified snapshots, not an atomic snapshot of the entire tree. */
export async function* inventoryLegacySources(root: string, options: InventoryOptions = {}): AsyncGenerator<LegacySourceEntry> {
  const signal = options.signal
  const maxDepth = bounded(options.maxDepth ?? 32, 0, 64, 'directory depth')
  const directoryBufferSize = bounded(options.directoryBufferSize ?? 32, 1, 64, 'directory buffer')
  checkAbort(signal)
  const checked = await checkedRoot(root)
  const rootIdentity = { dev: checked.stat.dev.toString(), ino: checked.stat.ino.toString() }
  const metrics = { directoryBufferSize, peakOpenDirectories: 0, peakOpenFiles: 0 }
  let openDirectories = 0, openFiles = 0
  async function members(path: string): Promise<DirectoryMembership> {
    const result = new DirectoryMembership(), dir = await opendir(path, { bufferSize: directoryBufferSize })
    metrics.peakOpenDirectories = Math.max(metrics.peakOpenDirectories, ++openDirectories)
    try {
      while (true) {
        checkAbort(signal)
        const entry = await dir.read()
        if (!entry) return result
        const file = join(path, entry.name)
        sourcePath(checked.path, relative(checked.path, file).split(sep).join('/'))
        result.add(entry.name, await lstat(file, { bigint: true }))
      }
    } finally { openDirectories--; await dir.close() }
  }
  async function* walk(path: string, depth: number): AsyncGenerator<LegacySourceEntry> {
    checkAbort(signal)
    if (depth > maxDepth) fail('READ_LIMIT', 'legacy directory depth exceeded')
    const before = await safeStat(checked.path, path, false)
    const beforeMembers = await members(path), observedMembers = new DirectoryMembership()
    const dir = await opendir(path, { bufferSize: directoryBufferSize })
    metrics.peakOpenDirectories = Math.max(metrics.peakOpenDirectories, ++openDirectories)
    let closed = false
    try {
      while (true) {
        checkAbort(signal)
        const entry = await dir.read()
        if (!entry) break
        const file = join(path, entry.name), stat = await lstat(file, { bigint: true })
        const relativePath = relative(checked.path, file).split(sep).join('/')
        sourcePath(checked.path, relativePath)
        observedMembers.add(entry.name, stat)
        if (stat.isSymbolicLink()) fail('LINK_REJECTED', 'linked legacy entry is not admitted')
        if (stat.isDirectory()) { yield* walk(file, depth + 1); continue }
        regular(stat)
        const size = Number(stat.size)
        if (!Number.isSafeInteger(size) || size < 0) fail('READ_LIMIT', 'legacy source size is not representable')
        const expected = identity(stat), hash = createHash('sha256')
        const handle = await checkedFile(checked.path, file, expected)
        metrics.peakOpenFiles = Math.max(metrics.peakOpenFiles, ++openFiles)
        try {
          const buffer = Buffer.alloc(MAX_CHUNK)
          let offset = 0
          while (offset < size) {
            checkAbort(signal)
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset)
            if (!bytesRead) fail('SOURCE_CHANGED', 'legacy source shortened while hashing')
            hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead
          }
          await unchangedFile(checked.path, file, handle, expected)
        } finally { openFiles--; await handle.close() }
        checkAbort(signal)
        yield { relativePath, size, sha256: hash.digest('hex'), identity: expected,
          rootIdentity: { ...rootIdentity }, inventoryMetrics: { ...metrics } }
      }
      // Close before the verification scan: retain the original depth+1 FD
      // bound, and do not depend on NTFS timestamps updating on an open handle.
      await dir.close(); closed = true; openDirectories--
      const afterMembers = await members(path)
      const after = await safeStat(checked.path, path, false)
      changed(identity(before), identity(after))
      if (!beforeMembers.equals(observedMembers) || !beforeMembers.equals(afterMembers)) fail('SOURCE_CHANGED', 'legacy directory membership changed')
    } finally { if (!closed) { openDirectories--; await dir.close() } }
  }
  try { yield* walk(checked.path, 0) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CaptureLegacyReadError('SOURCE_CHANGED', 'legacy source disappeared during inventory', { cause: error })
    throw error
  }
}

class LineFramer {
  readonly buffer: Buffer
  private decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  private offset = 0
  private start = 0
  private length = 0
  private invalid = false
  lineCount = 0
  maxBufferedLineBytes = 0
  constructor(private maxBytes: number) { this.buffer = Buffer.alloc(maxBytes) }
  private consume(bytes: Uint8Array) {
    const previous = this.length
    this.length += bytes.length; this.offset += bytes.length
    if (!this.invalid) {
      try { this.decoder.decode(bytes, { stream: true }) } catch { this.invalid = true }
    }
    if (previous < this.maxBytes) {
      const retained = Math.min(bytes.length, this.maxBytes - previous)
      this.buffer.set(bytes.subarray(0, retained), previous)
      this.maxBufferedLineBytes = Math.max(this.maxBufferedLineBytes, previous + retained)
    }
  }
  private finish(newline: boolean): Extract<LegacyReadEvent, { kind: 'line' }> {
    if (!this.invalid) { try { this.decoder.decode() } catch { this.invalid = true } }
    const issues: LegacyLineIssue[] = []
    if (this.invalid) issues.push('INVALID_UTF8')
    if (this.length > this.maxBytes) issues.push('LINE_TOO_LARGE')
    if (!newline) issues.push('MALFORMED_EOF')
    const event: Extract<LegacyReadEvent, { kind: 'line' }> = {
      kind: 'line', line: ++this.lineCount, startOffset: this.start,
      nextOffset: this.offset + (newline ? 1 : 0), contentBytes: this.length,
      status: issues.length ? 'rejected' : 'valid', issues,
      ...(issues.length ? {} : { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
        .decode(this.buffer.subarray(0, this.length)) }),
    }
    this.offset = event.nextOffset; this.start = event.nextOffset; this.length = 0; this.invalid = false
    this.decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    return event
  }
  *push(bytes: Uint8Array) {
    let start = 0
    for (let index = 0; index < bytes.length; index++) if (bytes[index] === 10) {
      this.consume(bytes.subarray(start, index)); yield this.finish(true); start = index + 1
    }
    this.consume(bytes.subarray(start))
  }
  eof() { return this.length ? this.finish(false) : undefined }
}

function copyEntry(entry: LegacySourceEntry): LegacySourceEntry {
  const expected = { relativePath: entry.relativePath, size: entry.size, sha256: entry.sha256,
    identity: { ...entry.identity }, rootIdentity: { ...entry.rootIdentity }, inventoryMetrics: { ...entry.inventoryMetrics } }
  if (!Number.isSafeInteger(expected.size) || expected.size < 0 || !/^[a-f0-9]{64}$/.test(expected.sha256))
    fail('SOURCE_TYPE', 'invalid expected legacy source metadata')
  const keys = ['dev', 'ino', 'nlink', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs'] as const
  for (const key of keys) {
    const format = key.endsWith('Ns') ? /^-?\d{1,32}$/ : /^\d{1,32}$/
    if (typeof expected.identity[key] !== 'string' || !format.test(expected.identity[key]))
      fail('SOURCE_TYPE', 'invalid expected legacy identity')
  }
  for (const key of ['dev', 'ino'] as const)
    if (typeof expected.rootIdentity[key] !== 'string' || !/^\d{1,32}$/.test(expected.rootIdentity[key]))
      fail('SOURCE_TYPE', 'invalid expected legacy root identity')
  if (expected.identity.size !== String(expected.size) || expected.identity.nlink !== '1')
    fail('SOURCE_TYPE', 'inconsistent expected legacy source metadata')
  return expected
}

/**
 * All chunks/text are private evidence. The caller owns each copied yielded chunk
 * and supplies backpressure by requesting the next event only after processing it.
 * Nothing is publishable until the final verified event; partial yields can fail.
 */
export function readLegacySource(root: string, entry: LegacySourceEntry, options: ReadOptions = {}): AsyncGenerator<LegacyReadEvent> {
  const expected = copyEntry(entry)
  sourcePath(resolve(root), expected.relativePath)
  const chunkBytes = bounded(options.chunkBytes ?? MAX_CHUNK, 1, MAX_CHUNK, 'physical chunk bytes')
  const maxLineBytes = bounded(options.maxLineBytes ?? MAX_LINE, 1, MAX_LINE, 'line content bytes')
  const signal = options.signal
  return (async function* () {
    checkAbort(signal)
    const checked = await checkedRoot(root)
    if (checked.stat.dev.toString() !== expected.rootIdentity.dev || checked.stat.ino.toString() !== expected.rootIdentity.ino)
      fail('SOURCE_CHANGED', 'legacy root identity changed')
    const file = sourcePath(checked.path, expected.relativePath)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await checkedFile(checked.path, file, expected.identity)
      const buffer = Buffer.alloc(chunkBytes), framer = new LineFramer(maxLineBytes), hash = createHash('sha256')
      let offset = 0, readCalls = 0, maxChunkBytes = 0, peakBufferedBytes = buffer.byteLength + framer.buffer.byteLength
      while (offset < expected.size) {
        checkAbort(signal)
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expected.size - offset), offset)
        readCalls++
        if (!bytesRead) fail('SOURCE_CHANGED', 'legacy source shortened while reading')
        const bytes = buffer.subarray(0, bytesRead)
        hash.update(bytes); maxChunkBytes = Math.max(maxChunkBytes, bytesRead)
        const transferred = Buffer.from(bytes)
        peakBufferedBytes = Math.max(peakBufferedBytes, buffer.byteLength + framer.buffer.byteLength + transferred.byteLength)
        yield { kind: 'chunk', offset, nextOffset: offset + bytesRead, bytes: transferred }
        checkAbort(signal)
        for (const line of framer.push(bytes)) { checkAbort(signal); yield line }
        offset += bytesRead
      }
      checkAbort(signal)
      const eof = framer.eof(); if (eof) yield eof
      checkAbort(signal)
      const finalRoot = await safeStat(checked.path, checked.path, false)
      if (finalRoot.dev.toString() !== expected.rootIdentity.dev || finalRoot.ino.toString() !== expected.rootIdentity.ino)
        fail('SOURCE_CHANGED', 'legacy root identity changed while reading')
      await unchangedFile(checked.path, file, handle, expected.identity)
      const sha256 = hash.digest('hex')
      if (sha256 !== expected.sha256) fail('SOURCE_CHANGED', 'legacy source hash changed')
      // Close before issuing the publication boundary, even if the caller stops here.
      await handle.close(); handle = undefined
      checkAbort(signal)
      yield { kind: 'verified', relativePath: expected.relativePath, size: offset, sha256,
        metrics: { peakBufferedBytes, maxBufferedLineBytes: framer.maxBufferedLineBytes, maxChunkBytes, readCalls, lineCount: framer.lineCount } }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new CaptureLegacyReadError('SOURCE_CHANGED', 'legacy source disappeared', { cause: error })
      throw error
    } finally { await handle?.close() }
  })()
}
