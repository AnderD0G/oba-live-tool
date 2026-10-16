import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface CaptureHandle {
  append(line: string): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}
export interface CaptureIO {
  open(file: string): Promise<CaptureHandle>
  atomic(file: string, text: string, beforeCommit?: () => void): Promise<void>
  read(file: string): Promise<string>
  list(directory: string): Promise<string[]>
  size(file: string): Promise<number>
  kind(file: string): Promise<'file' | 'directory' | 'link' | 'missing' | 'other'>
  mkdir(directory: string): Promise<void>
  chunks(file: string, start?: number): AsyncIterable<Buffer>
}
export const NODE_CAPTURE_IO: CaptureIO = {
  open: async file => {
    const handle = await open(file, 'a')
    return {
      append: async line => {
        await handle.writeFile(line, 'utf8')
      },
      sync: () => handle.sync(),
      close: () => handle.close(),
    }
  },
  atomic: async (file, text, beforeCommit) => {
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.pending-${randomUUID()}`
    const handle = await open(temporary, 'wx')
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    // Never delete a failed temporary file: it is evidence and included in recovery capacity accounting.
    beforeCommit?.()
    await rename(temporary, file)
  },
  read: file => readFile(file, 'utf8'),
  list: directory => readdir(directory),
  size: async file => (await stat(file)).size,
  kind: async file => {
    try {
      const value = await lstat(file)
      return value.isSymbolicLink()
        ? 'link'
        : value.isDirectory()
          ? 'directory'
          : value.isFile()
            ? 'file'
            : 'other'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
      throw error
    }
  },
  mkdir: async directory => {
    await mkdir(directory, { recursive: true })
  },
  chunks: (file, start = 0) => createReadStream(file, { highWaterMark: 64 * 1024, start }),
}

export interface CaptureLine {
  text?: string
  line: number
  nextOffset: number
}
/** Long/corrupt lines are skipped without buffering the whole shard or exposing their bytes. */
export async function* captureLines(
  io: CaptureIO,
  file: string,
  maxBytes: number,
  start = 0,
): AsyncGenerator<CaptureLine> {
  let parts: Buffer[] = []
  let length = 0
  let over = false
  let line = 0
  let offset = start
  for await (const chunk of io.chunks(file, start)) {
    let beginning = 0
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 10) continue
      const piece = chunk.subarray(beginning, i)
      length += piece.length
      if (!over && length <= maxBytes) parts.push(piece)
      else {
        parts = []
        over = true
      }
      offset += i - beginning + 1
      yield {
        ...(over ? {} : { text: Buffer.concat(parts).toString('utf8') }),
        line: ++line,
        nextOffset: offset,
      }
      parts = []
      length = 0
      over = false
      beginning = i + 1
    }
    const remainder = chunk.subarray(beginning)
    offset += remainder.length
    length += remainder.length
    if (!over && length <= maxBytes) parts.push(remainder)
    else {
      parts = []
      over = true
    }
  }
  // Incomplete final writes are evidence, not a successfully appended record.
  if (length > 0 || over) yield { line: ++line, nextOffset: offset }
}
