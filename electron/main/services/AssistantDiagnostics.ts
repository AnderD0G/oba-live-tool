import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFile, mkdir, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

export interface AssistantDiagnosticContext {
  traceId: string
  action: string
  accountId?: string
  rowId?: string
  sessionId?: string
  requestId?: string
}
export interface AssistantDiagnosticEvent extends AssistantDiagnosticContext {
  stage: string
  phase: 'start' | 'finish' | 'error'
  durationMs?: number
  code?: string
  counts?: Record<string, number>
}
export type AssistantDiagnosticTrace = (event: AssistantDiagnosticEvent) => void
const diagnosticScope = new AsyncLocalStorage<{ context: AssistantDiagnosticContext; trace: AssistantDiagnosticTrace | undefined }>()
export function currentAssistantDiagnostic() { return diagnosticScope.getStore() }

const MAX_SEGMENT_BYTES = 32 * 1024 * 1024
const MAX_PENDING = 512
const MAX_LINE_BYTES = 4096
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
const label = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,80}$/.test(value)

/** Safe metadata only: neither error messages nor provider payloads enter this file. */
export function assistantDiagnosticCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const value = error as { code?: unknown; name?: unknown; status?: unknown }
    if (typeof value.code === 'string' && /^[A-Z][A-Z0-9_.:-]{0,79}$/.test(value.code)) return value.code
    if (value.name === 'TimeoutError' || value.name === 'APIConnectionTimeoutError') return 'TIMEOUT'
    if (value.name === 'AbortError' || value.name === 'APIUserAbortError') return 'ABORTED'
    if (Number.isInteger(value.status) && Number(value.status) >= 100 && Number(value.status) <= 599) return `HTTP_${value.status}`
  }
  return 'OPERATION_FAILED'
}

function safeTrace(trace: AssistantDiagnosticTrace | undefined, event: AssistantDiagnosticEvent) {
  try { trace?.(event) } catch { /* Diagnostics never change the operation's outcome. */ }
}

export async function runAssistantDiagnosticStage<T>(
  trace: AssistantDiagnosticTrace | undefined,
  context: AssistantDiagnosticContext,
  stage: string,
  run: () => Promise<T>,
): Promise<T> {
  const started = performance.now()
  safeTrace(trace, { ...context, stage, phase: 'start' })
  try {
    const result = await diagnosticScope.run({ context, trace }, run)
    const failure = result && typeof result === 'object' && 'ok' in result && result.ok === false
    safeTrace(trace, { ...context, stage, phase: failure ? 'error' : 'finish', durationMs: Math.max(0, performance.now() - started),
      ...(failure ? { code: assistantDiagnosticCode('error' in result ? result.error : undefined) } : {}) })
    return result
  } catch (error) {
    safeTrace(trace, { ...context, stage, phase: 'error', durationMs: Math.max(0, performance.now() - started), code: assistantDiagnosticCode(error) })
    throw error
  }
}

/** Bounded asynchronous local JSONL. An unavailable log directory cannot block live work. */
export function createAssistantDiagnostics(directory: string, options: { append?: (filename: string, data: string) => Promise<void> } = {}): { trace: AssistantDiagnosticTrace; flush: () => Promise<void> } {
  const root = resolve(directory)
  const queue: { day: string; line: string }[] = []
  let writing: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined
  let initialized = false, activeDay = '', bytes = 0, segment = 0, dropped = 0
  const filename = (day: string) => join(root, `assistant-diagnostics-${day}${segment ? `-${String(segment).padStart(3, '0')}` : ''}.jsonl`)
  const append = async (day: string, line: string) => {
    const size = Buffer.byteLength(line)
    if (!initialized) { await mkdir(root, { recursive: true }); initialized = true }
    if (activeDay !== day) {
      const suffix = new RegExp(`^assistant-diagnostics-${day}(?:-(\\d+))?\\.jsonl$`)
      segment = (await readdir(root)).reduce((highest, name) => { const match = suffix.exec(name); return match ? Math.max(highest, Number(match[1] ?? 0)) : highest }, 0)
      bytes = await stat(filename(day)).then(value => value.size).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
        throw error
      })
      activeDay = day
    }
    if (bytes + size > MAX_SEGMENT_BYTES) { segment++; bytes = 0 }
    if (options.append) await options.append(filename(day), line)
    else await appendFile(filename(day), line, 'utf8')
    bytes += size
  }
  const drain = (): Promise<void> => {
    if (timer) { clearTimeout(timer); timer = undefined }
    if (writing) return writing
    writing = (async () => {
      let first = true
      while (queue.length || first && dropped) {
        first = false
        const batch = queue.splice(0, 64)
        const day = batch[0]?.day ?? new Date().toISOString().slice(0, 10)
        try {
          if (dropped) {
            const gap = dropped
            await append(day, `${JSON.stringify({ timestamp: new Date().toISOString(), traceId: 'diagnostic-writer', action: 'diagnostics', stage: 'diagnostic-gap', phase: 'error', code: 'DIAGNOSTIC_EVENTS_DROPPED', counts: { dropped: gap } })}\n`)
            dropped -= gap
          }
          let currentDay = '', lines = ''
          for (const entry of batch) {
            if (currentDay && currentDay !== entry.day) { await append(currentDay, lines); lines = '' }
            currentDay = entry.day; lines += entry.line
          }
          if (lines) await append(currentDay, lines)
        } catch { dropped += batch.length }
      }
    })().finally(() => {
      writing = undefined
      if (queue.length && !timer) { timer = setTimeout(() => { void drain() }, 20); timer.unref() }
    })
    return writing
  }
  const trace: AssistantDiagnosticTrace = event => {
    if (queue.length >= MAX_PENDING) { dropped++; return }
    if (!identifier(event.traceId) || !label(event.action) || !label(event.stage) || !['start', 'finish', 'error'].includes(event.phase)) return
    const timestamp = new Date().toISOString(), day = timestamp.slice(0, 10)
    const output: Record<string, unknown> = { timestamp, traceId: event.traceId, action: event.action, stage: event.stage, phase: event.phase }
    for (const key of ['accountId', 'rowId', 'sessionId', 'requestId'] as const) if (identifier(event[key])) output[key] = event[key]
    if (typeof event.durationMs === 'number' && Number.isFinite(event.durationMs) && event.durationMs >= 0) output.durationMs = Math.round(event.durationMs * 100) / 100
    if (label(event.code)) output.code = event.code
    if (event.counts && typeof event.counts === 'object') {
      const counts = Object.fromEntries(Object.entries(event.counts).filter(([key, value]) => label(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0).slice(0, 16))
      if (Object.keys(counts).length) output.counts = counts
    }
    const line = `${JSON.stringify(output)}\n`, size = Buffer.byteLength(line)
    if (size > MAX_LINE_BYTES) return
    queue.push({ day, line })
    if (!writing && !timer) { timer = setTimeout(() => { void drain() }, 20); timer.unref() }
  }
  return { trace, flush: async () => { await drain(); if (queue.length) await drain() } }
}
