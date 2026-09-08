import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  CodexDraftProgress,
  CodexDraftRequest,
  CodexDraftResult,
  CodexStatus,
} from '../../../shared/codexDraft'
import { CodexAppServer } from './CodexAppServer'
import { buildPrompt, findCodex, validateRequest } from './CodexDraftService'

export function buildServerArgs(): string[] {
  const args = ['app-server', '--listen', 'stdio://']
  for (const config of [
    'approval_policy="never"',
    'sandbox_mode="read-only"',
    'web_search="disabled"',
    'model_reasoning_effort="low"',
    'project_doc_max_bytes=0',
    'developer_instructions=""',
  ])
    args.push('-c', config)
  for (const feature of [
    'shell_tool',
    'unified_exec',
    'apps',
    'plugins',
    'hooks',
    'memories',
    'multi_agent',
    'browser_use',
    'computer_use',
    'image_generation',
    'view_image',
    'code_mode',
    'code_mode_host',
    'skill_search',
    'workspace_dependencies',
  ])
    args.push('--disable', feature)
  return args
}

interface Runtime {
  server: CodexAppServer
  directory: string
  executable: string
  config: Record<string, unknown>
}
interface DraftEvent {
  threadId: string
  turn: { id: string; status: string }
  itemId: string
  delta: string
  willRetry?: boolean
  item?: { id: string; type: string; text: string }
}
interface Job {
  id: string
  owner: number
  cancelled: boolean
  runtime?: Runtime
  threadId?: string
  turnId?: string
  stop?: (error: Error) => void
  cancelTimer?: ReturnType<typeof setTimeout>
}

export class PersistentCodexDraftService {
  get isBusy() {
    return !!this.active
  }
  private runtime?: Runtime
  private starting?: Promise<Runtime>
  private active?: Job
  private closed = false

  constructor(
    private readonly resolveEnvironment: () => Promise<NodeJS.ProcessEnv> = async () => ({
      ...process.env,
    }),
    private readonly createServer?: (directory: string) => Promise<CodexAppServer>,
  ) {}

  private async ready(): Promise<Runtime> {
    if (this.closed) throw new Error('Codex 服务已关闭')
    if (this.starting) return this.starting
    if (this.runtime?.server.alive) return this.runtime
    if (this.runtime) this.release(this.runtime)
    const starting = this.startRuntime()
    this.starting = starting
    try {
      return await starting
    } finally {
      if (this.starting === starting) this.starting = undefined
    }
  }

  private async startRuntime(): Promise<Runtime> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'oba-codex-'))
    let runtime: Runtime | undefined
    try {
      const executable = this.createServer ? 'test-transport' : await findCodex()
      const server = this.createServer
        ? await this.createServer(directory)
        : new CodexAppServer({
            executable,
            args: buildServerArgs(),
            cwd: directory,
            env: await this.resolveEnvironment(),
          })
      runtime = { server, directory, executable, config: {} }
      this.runtime = runtime
      if (this.closed) throw new Error('Codex 服务已关闭')
      await server.start()
      // Saved auth is reused; inherited MCP servers are disabled only for our threads.
      // Never log config contents or write to the user's global configuration.
      const effective = await server.request<{
        config?: { mcp_servers?: Record<string, unknown> }
      }>('config/read', {
        includeLayers: false,
        cwd: directory,
      })
      const servers = effective.config?.mcp_servers ?? {}
      for (const name of Object.keys(servers)) runtime.config[`mcp_servers.${name}.enabled`] = false
      runtime.config.developer_instructions = ''
      runtime.config.project_doc_max_bytes = 0
      runtime.config.web_search = 'disabled'
      return runtime
    } catch (error) {
      if (runtime) this.release(runtime)
      else await rm(directory, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  private release(runtime: Runtime) {
    if (this.runtime === runtime) this.runtime = undefined
    runtime.server.dispose()
    void rm(runtime.directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }

  async status(): Promise<CodexStatus> {
    try {
      const runtime = await this.ready()
      return {
        available: true,
        path: runtime.executable,
        version: 'Codex app-server',
        pid: runtime.server.pid,
      }
    } catch (error) {
      return { available: false, error: error instanceof Error ? error.message : '启动失败' }
    }
  }

  dispose() {
    this.closed = true
    this.active?.stop?.(new Error('Codex 服务已关闭'))
    if (this.runtime) this.release(this.runtime)
  }

  cancel(owner: number, id?: string): boolean {
    const job = this.active
    if (!job || job.owner !== owner || (id && job.id !== id)) return false
    job.cancelled = true
    this.interrupt(job)
    return true
  }

  private interrupt(job: Job) {
    if (!job.runtime || !job.threadId || !job.turnId || job.cancelTimer) return
    job.cancelTimer = setTimeout(() => {
      job.stop?.(new Error('已取消生成'))
      if (job.runtime) this.release(job.runtime)
    }, 3000)
    void job.runtime.server
      .request('turn/interrupt', { threadId: job.threadId, turnId: job.turnId }, 3000)
      .catch(() => {
        job.stop?.(new Error('已取消生成'))
        if (job.runtime) this.release(job.runtime)
      })
  }

  async generate(
    owner: number,
    request: CodexDraftRequest,
    progress: (event: CodexDraftProgress) => void = () => {},
  ): Promise<CodexDraftResult> {
    try {
      validateRequest(request)
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
    if (this.active) return { ok: false, error: '已有一条评论正在生成，请等待完成或先取消。' }
    const job: Job = { id: request.requestId, owner, cancelled: false }
    this.active = job
    const started = Date.now()
    let firstTextMs: number | undefined
    let unsubscribe: (() => void) | undefined
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      job.stop?.(new Error('生成超过 120 秒，请检查网络后重试'))
      if (job.runtime) this.release(job.runtime)
    }, 120000)
    try {
      progress({
        message: this.runtime?.server.alive ? '正在复用常驻 Codex…' : '正在启动常驻 Codex…',
      })
      const runtime = await this.ready()
      job.runtime = runtime
      if (job.cancelled || timedOut) throw new Error(job.cancelled ? '已取消生成' : '生成超时')
      const thread = await runtime.server.request<{ thread: { id: string } }>('thread/start', {
        cwd: runtime.directory,
        ephemeral: true,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        model: request.model,
        config: runtime.config,
        baseInstructions: '你是直播评论回复草稿助手。只输出简短中文回复，不调用任何工具。',
        developerInstructions: '',
        environments: [],
        dynamicTools: [],
        selectedCapabilityRoots: [],
      })
      job.threadId = thread.thread.id
      if (job.cancelled || timedOut) throw new Error(job.cancelled ? '已取消生成' : '生成超时')
      const messages = new Map<string, string>()
      const completion = new Promise<string>((resolve, reject) => {
        job.stop = reject
        unsubscribe = runtime.server.onNotification(event => {
          if (event.method === 'transport/closed') {
            reject(new Error('Codex 常驻服务已断开，请重试'))
            return
          }
          const params = event.params as unknown as DraftEvent | undefined
          if (!params || params.threadId !== job.threadId) return
          if (event.method === 'turn/started') {
            job.turnId = params.turn.id
            if (job.cancelled) this.interrupt(job)
          }
          if (event.method === 'error')
            progress({
              message: params.willRetry
                ? '网络连接不稳定，Codex 正在重试…'
                : '请求未完成，正在确认状态…',
            })
          if (event.method === 'item/agentMessage/delta' && !job.cancelled) {
            messages.set(params.itemId, (messages.get(params.itemId) ?? '') + params.delta)
            const text = [...messages.values()].join('\n')
            if (text.length > 8000) {
              reject(new Error('回复过长，请缩短回复要求后重试'))
              this.interrupt(job)
              return
            }
            if (text && firstTextMs === undefined) firstTextMs = Date.now() - started
            progress({ message: '正在接收回复…', text })
          }
          if (event.method === 'item/completed' && params.item?.type === 'agentMessage')
            messages.set(params.item.id, params.item.text)
          if (event.method === 'turn/completed') {
            if (job.cancelled || params.turn.status === 'interrupted') {
              reject(new Error('已取消生成'))
              return
            }
            if (params.turn.status !== 'completed') {
              reject(new Error('Codex 生成失败，请检查模型、登录和网络后重试'))
              return
            }
            const text = [...messages.values()].join('\n').trim()
            if (!text || text.length > 8000) reject(new Error('Codex 未返回有效草稿，请重试'))
            else resolve(text)
          }
        })
      })
      void completion.catch(() => {})
      progress({ message: '常驻进程已就绪，正在等待模型回复…' })
      const turn = await runtime.server.request<{ turn: { id: string } }>('turn/start', {
        threadId: job.threadId,
        input: [{ type: 'text', text: buildPrompt(request) }],
        effort: 'low',
      })
      job.turnId = turn.turn.id
      if (job.cancelled) this.interrupt(job)
      const text = await completion
      return { ok: true, text, elapsedMs: Date.now() - started, firstTextMs }
    } catch (error) {
      return {
        ok: false,
        error: job.cancelled
          ? '已取消生成'
          : timedOut
            ? '生成超过 120 秒，请检查网络后重试'
            : error instanceof Error
              ? error.message
              : '生成失败',
      }
    } finally {
      clearTimeout(timer)
      if (job.cancelTimer) clearTimeout(job.cancelTimer)
      unsubscribe?.()
      if (job.threadId && job.runtime?.server.alive) {
        try {
          await job.runtime.server.request('thread/unsubscribe', { threadId: job.threadId }, 3000)
        } catch {
          this.release(job.runtime)
        }
      }
      if (this.active === job) this.active = undefined
    }
  }
}
