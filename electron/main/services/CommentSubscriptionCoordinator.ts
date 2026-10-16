import {
  AnalysisError,
  type AnalysisScope,
  type BusinessObservation,
  validateAnalysisScope,
} from '../../../shared/analysisRoom'
import type { BusinessSourceObservation, ICommentListener } from '../platforms/IPlatform'

export interface CommentConsumer {
  id: string
  onComment?: (message: LiveMessage) => void
  listenerSource?: CommentListenerConfig['source']
}
export interface CommentSubscription {
  ready: Promise<void>
  release(): Promise<void>
}
interface Generation {
  source: AnalysisScope['source']
  listenerSource: CommentListenerConfig['source']
  consumers: Map<string, CommentConsumer>
  ready: Promise<void>
  started: boolean
  unsubscribe?: () => void
  unsubscribeInvalidation?: () => void
  stopping?: Promise<void>
}
interface CoordinatorOptions {
  scope: AnalysisScope
  listener: ICommentListener & {
    subscribeBusiness?: (callback: (input: BusinessSourceObservation) => void) => () => void
  }
  observeBusiness: (input: BusinessObservation) => void
  onInvalidated?: (reason: string) => void
  onError?: (reason: string) => void
  /** A replacement must not start until the previous coordinator releases the shared listener. */
  waitForCleanup?: Promise<void>
  /** Revalidate the selected owner/page after a possibly held cleanup barrier. */
  beforeStart?: () => void
}

/** Historical platform-named entries use the control listener; the original adapter argument is retained. */
export function normalizeCommentSource(
  source: CommentListenerConfig['source'],
): AnalysisScope['source'] {
  if (
    ![
      'control',
      'compass',
      'xiaohongshu',
      'wechat-channel',
      'taobao',
      'kuaishou',
      'tiktok',
    ].includes(source)
  ) {
    throw new AnalysisError('ANALYSIS_INVALID_INPUT', '监听来源无效')
  }
  return source === 'compass' ? 'compass' : 'control'
}

/** One listener per connected account; leases own consumers, never the underlying platform. */
export class CommentSubscriptionCoordinator {
  readonly scope: AnalysisScope
  private generation?: Generation
  private tail: Promise<void> = Promise.resolve()
  private closed = false
  constructor(private readonly options: CoordinatorOptions) {
    this.scope = validateAnalysisScope(options.scope)
    if (options.waitForCleanup) this.tail = options.waitForCleanup.catch(() => {})
  }
  get isClosed(): boolean { return this.closed }
  get cleanupComplete(): Promise<void> { return this.tail }
  get activeSource(): AnalysisScope['source'] | undefined {
    return this.generation?.source
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.tail.then(work)
    this.tail = result.catch(() => {})
    return result
  }
  private validateScope(scope: AnalysisScope): void {
    validateAnalysisScope(scope)
    if (this.closed) throw new AnalysisError('ANALYSIS_NOT_CONNECTED', '账号连接已断开')
    if (scope.accountId !== this.scope.accountId || scope.platform !== this.scope.platform)
      throw new AnalysisError('ANALYSIS_INVALID_INPUT', '监听账号范围不一致')
  }
  assertCanReplace(scope: AnalysisScope, consumerId: string): void {
    this.validateScope(scope)
    const gen = this.generation
    if (
      gen &&
      gen.source !== scope.source &&
      [...gen.consumers.keys()].some(id => id !== consumerId)
    ) {
      throw new AnalysisError('ANALYSIS_SOURCE_CONFLICT', '其他消费者正在监听不同来源')
    }
  }
  acquire(scope: AnalysisScope, consumer: CommentConsumer): CommentSubscription {
    this.validateScope(scope)
    if (!consumer.id || consumer.id.length > 256)
      throw new AnalysisError('ANALYSIS_INVALID_INPUT', '监听消费者无效')
    let gen = this.generation
    if (gen && gen.source !== scope.source)
      throw new AnalysisError('ANALYSIS_SOURCE_CONFLICT', '正在监听不同来源')
    if (gen?.consumers.has(consumer.id))
      throw new AnalysisError('ANALYSIS_REQUEST_CONFLICT', '消费者已持有监听订阅')
    if (!gen) {
      gen = {
        source: scope.source,
        listenerSource: consumer.listenerSource ?? scope.source,
        consumers: new Map(),
        ready: Promise.resolve(),
        started: false,
      }
      this.generation = gen
      const current = gen
      gen.ready = this.enqueue(async () => {
        if (this.closed || current.consumers.size === 0)
          throw new AnalysisError('ANALYSIS_NOT_CONNECTED', '监听请求已取消')
        try {
          this.options.beforeStart?.()
          current.unsubscribeInvalidation = this.options.listener.subscribeListenerInvalidation?.(reason => {
            if (!this.closed && this.generation === current) this.invalidate(reason)
          })
          current.unsubscribe = this.options.listener.subscribeBusiness?.(input => {
            if (this.closed || this.generation !== current || !current.consumers.size) return
            try {
              this.options.observeBusiness({
                ...input,
                scope: { ...this.scope, source: current.source },
              })
            } catch {
              this.options.onError?.('BUSINESS_OBSERVER_FAILED')
            }
          })
          await this.options.listener.startCommentListener(message => {
            if (this.closed || this.generation !== current) return
            for (const entry of current.consumers.values()) {
              try {
                entry.onComment?.(message)
              } catch {
                this.options.onError?.('COMMENT_CONSUMER_FAILED')
              }
            }
          }, current.listenerSource)
          current.started = true
        } catch (error) {
          current.unsubscribe?.()
          current.unsubscribe = undefined
          current.unsubscribeInvalidation?.()
          current.unsubscribeInvalidation = undefined
          current.started = false
          try { await this.options.listener.stopCommentListener() }
          finally {
            current.consumers.clear()
            if (this.generation === current) this.generation = undefined
          }
          throw error
        }
      })
      // A caller may release before awaiting ready; retain cancellation without unhandled rejection.
      gen.ready.catch(() => {})
    }
    gen.consumers.set(consumer.id, consumer)
    const current = gen
    let released = false
    const ready = current.ready.then(() => {
      if (released || this.closed || this.generation !== current)
        throw new AnalysisError('ANALYSIS_NOT_CONNECTED', '监听订阅已释放')
    })
    ready.catch(() => {})
    let releaseResult: Promise<void> | undefined
    return {
      ready,
      release: () => {
        if (released) return releaseResult ?? Promise.resolve()
        released = true
        current.consumers.delete(consumer.id)
        if (current.consumers.size === 0) {
          if (this.generation === current) this.generation = undefined
          releaseResult = this.stop(current)
        }
        return releaseResult ?? Promise.resolve()
      },
    }
  }
  private stop(gen: Generation): Promise<void> {
    if (!gen.stopping)
      gen.stopping = this.enqueue(async () => {
        gen.unsubscribe?.()
        gen.unsubscribe = undefined
        gen.unsubscribeInvalidation?.()
        gen.unsubscribeInvalidation = undefined
        if (gen.started) {
          gen.started = false
          await this.options.listener.stopCommentListener()
        }
      })
    return gen.stopping
  }
  invalidate(reason: string): void {
    if (this.closed) return
    this.closed = true
    const gen = this.generation
    this.generation = undefined
    if (gen) {
      gen.unsubscribe?.()
      gen.unsubscribe = undefined
      gen.unsubscribeInvalidation?.()
      gen.unsubscribeInvalidation = undefined
      gen.consumers.clear()
      this.stop(gen).catch(() => this.options.onError?.('LISTENER_STOP_FAILED'))
    }
    this.options.onInvalidated?.(reason)
  }
}
