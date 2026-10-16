import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import path from 'node:path'
import type { AuditDraft, AuditEntry } from '../../../shared/audit'

/** Append-only daily records: a crash never rewrites earlier audit history. */
export class AuditLogStore {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true })
    this.prune()
  }

  append(draft: AuditDraft) {
    const entry: AuditEntry = { ...draft, id: randomUUID(), at: Date.now() }
    const date = new Date(entry.at).toISOString().slice(0, 10)
    appendFileSync(path.join(this.directory, `${date}.jsonl`), `${JSON.stringify(entry)}\n`, 'utf8')
    return entry
  }

  list(limit = 200, accountId?: string): AuditEntry[] {
    const max = Math.min(Math.max(Math.floor(limit) || 200, 1), 500)
    const files = readdirSync(this.directory)
      .filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort()
      .reverse()
    const result: AuditEntry[] = []
    for (const file of files) {
      const filename = path.join(this.directory, file)
      const size = statSync(filename).size
      const bytes = Math.min(size, 2 * 1024 * 1024)
      const buffer = Buffer.alloc(bytes)
      const fd = openSync(filename, 'r')
      try {
        readSync(fd, buffer, 0, bytes, size - bytes)
      } finally {
        closeSync(fd)
      }
      const raw = buffer.toString('utf8')
      const lines = (size > bytes ? raw.slice(raw.indexOf('\n') + 1) : raw).trimEnd().split('\n')
      for (let index = lines.length - 1; index >= 0; index--) {
        try {
          const entry = JSON.parse(lines[index]) as AuditEntry
          if (!accountId || entry.accountId === accountId) result.push(entry)
          if (result.length >= max) return result
        } catch {
          /* tolerate an interrupted final write */
        }
      }
    }
    return result
  }

  private prune() {
    const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
    for (const file of readdirSync(this.directory)) {
      if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file) && file.slice(0, 10) < cutoff) {
        const filename = path.join(this.directory, file)
        if (existsSync(filename)) unlinkSync(filename)
      }
    }
  }
}
