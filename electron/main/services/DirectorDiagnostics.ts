import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { closeSync, openSync, writeSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

export type DiagnosticContext = {
  phase?: string
  step?: string
  stepId?: string
  file?: string
  productId?: string
}

// Only media/scene fields are retained: never serialize configuration, text, or credentials.
const fields = new Set([
  'inputName',
  'sourceName',
  'sceneName',
  'sceneItemId',
  'sceneItemEnabled',
  'mediaAction',
  'mediaState',
  'mediaCursor',
  'mediaDuration',
  'inputMuted',
  'local_file',
  'file',
  'looping',
  'restart_on_activate',
  'close_when_inactive',
  'clear_on_media_end',
  'inputSettings',
  'requestType',
  'requestId',
  'code',
  'result',
  'eventType',
  'eventData',
  'inputKind',
  'overlay',
  'outputActive',
])

export function diagnosticFields(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (!fields.has(key)) continue
    if (value && typeof value === 'object' && !Array.isArray(value))
      result[key] = diagnosticFields(value as Record<string, unknown>)
    else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      result[key] = value
  }
  return result
}

export class DirectorDiagnostics {
  readonly runId = randomUUID()
  private context = new AsyncLocalStorage<DiagnosticContext>()
  private bytes = 0
  private fd: number | undefined
  private capped = false
  private sources = new Map<string, DiagnosticContext & { sourceFile?: string }>()

  constructor(
    readonly path: string,
    private maxBytes = 32 * 1024 * 1024,
  ) {
    if (maxBytes < 1024) throw new Error('Diagnostic limit must be at least 1024 bytes')
    this.fd = openSync(path, 'wx')
    this.record('run.start')
  }

  scope<T>(context: DiagnosticContext, action: () => T): T {
    return this.context.run(context, action)
  }

  record(kind: string, data: Record<string, unknown> = {}) {
    if (this.fd === undefined || this.capped) return
    const event = data.eventData as Record<string, unknown> | undefined
    const source = String(data.inputName || event?.inputName || '')
    const context = this.context.getStore()
    if (kind === 'obs.command' && source) {
      const settings = data.inputSettings as Record<string, unknown> | undefined
      this.sources.set(source, {
        ...this.sources.get(source),
        ...context,
        ...(typeof settings?.local_file === 'string' ? { sourceFile: settings.local_file } : {}),
      })
    }
    const row = (event: string, details: Record<string, unknown>) =>
      `${JSON.stringify({
        runId: this.runId,
        wallTime: new Date().toISOString(),
        monotonicMs: performance.now(),
        ...(source ? this.sources.get(source) : undefined),
        ...context,
        kind: event,
        ...details,
      })}\n`
    let line = row(kind, diagnosticFields(data))
    if (this.bytes + Buffer.byteLength(line) > this.maxBytes - 512) {
      line = `${JSON.stringify({
        runId: this.runId,
        wallTime: new Date().toISOString(),
        monotonicMs: performance.now(),
        kind: 'trace.limit',
      })}\n`
      this.capped = true
      console.warn(`Director diagnostic size limit reached: ${this.path}`)
    }
    this.bytes += writeSync(this.fd, line)
  }

  close() {
    if (this.fd === undefined) return
    this.record('run.end')
    closeSync(this.fd)
    this.fd = undefined
  }
}
