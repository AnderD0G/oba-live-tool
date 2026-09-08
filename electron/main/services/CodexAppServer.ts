import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export interface RpcMessage {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code?: number; message?: string }
}

/** A private stdio connection: no listening port and no desktop daemon sharing. */
export class CodexAppServer {
  private child?: ChildProcessWithoutNullStreams
  private starting?: Promise<void>
  private closed = false
  private nextId = 0
  private pending = new Map<
    number,
    {
      resolve: (result: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private listeners = new Set<(message: RpcMessage) => void>()

  constructor(
    private readonly options: {
      executable: string
      args: string[]
      cwd: string
      env: NodeJS.ProcessEnv
    },
  ) {}

  get pid() {
    return this.child?.pid
  }
  get alive() {
    return !!this.child && this.child.exitCode === null && !this.closed
  }

  start(): Promise<void> {
    if (this.starting) return this.starting
    this.starting = this.initialize()
    return this.starting
  }

  private async initialize() {
    if (this.closed) throw new Error('Codex 常驻服务已关闭')
    const child = spawn(this.options.executable, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      shell: false,
      windowsHide: true,
      stdio: 'pipe',
    })
    this.child = child
    child.stdin.on('error', () => this.fail())
    child.on('error', () => this.fail())
    child.on('close', () => this.fail())
    // Drain diagnostics without exposing account information in the renderer/logs.
    child.stderr.on('data', () => {})
    const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY })
    lines.on('line', line => {
      try {
        this.receive(JSON.parse(line))
      } catch {
        /* Ignore non-protocol output. */
      }
    })
    child.once('close', () => lines.close())
    await this.request('initialize', {
      clientInfo: {
        name: 'oba_comment_drafts',
        title: 'OBA Comment Drafts',
        version: '1.6.1-codex.3',
      },
      capabilities: { experimentalApi: true },
    })
    this.write({ method: 'initialized', params: {} })
  }

  onNotification(listener: (message: RpcMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  request<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    timeout = 20000,
  ): Promise<T> {
    if (!this.alive) return Promise.reject(new Error('Codex 常驻服务已断开，请重试'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Codex 服务响应超时，请重试'))
      }, timeout)
      this.pending.set(id, { resolve: result => resolve(result as T), reject, timer })
      try {
        this.write({ id, method, params })
      } catch {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error('Codex 常驻服务已断开，请重试'))
      }
    })
  }

  private write(message: RpcMessage) {
    if (!this.alive) throw new Error('Codex 常驻服务已断开')
    this.child?.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private receive(message: RpcMessage) {
    if (message.id !== undefined && message.method) {
      // No approval, external tool, or user-input request is executed by this integration.
      this.write({
        id: message.id,
        error: { code: -32601, message: 'This client only supports text reply drafts.' },
      })
      return
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error('Codex 请求失败，请检查模型、登录和网络'))
      else pending.resolve(message.result)
      return
    }
    for (const listener of this.listeners) listener(message)
  }

  private fail() {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Codex 常驻服务已断开，请重试'))
    }
    this.pending.clear()
    for (const listener of this.listeners) listener({ method: 'transport/closed' })
    this.child?.kill()
  }

  dispose() {
    this.fail()
  }
}
