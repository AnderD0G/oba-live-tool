import { Result } from '@praha/byethrow'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { emitter } from '#/event/eventBus'
import type { ScopedLogger } from '#/logger'
import type { ICommentListener } from '#/platforms/IPlatform'
import {
  type CommentSubscription,
  CommentSubscriptionCoordinator,
  normalizeCommentSource,
} from '#/services/CommentSubscriptionCoordinator'
import { WebSocketService } from '#/services/WebSocketService'
import windowManager from '#/windowManager'
import { createTask } from './BaseTask'
import { TaskStopReason } from './ITask'

const TASK_NAME = '自动回复'

export function createCommentListenerTask(
  platform: ICommentListener,
  config: CommentListenerConfig,
  account: Account,
  _logger: ScopedLogger,
  subscriptions?: CommentSubscriptionCoordinator,
) {
  const logger = _logger.scope(TASK_NAME)
  let wsService: WebSocketService | null
  const coordinator =
    subscriptions ??
    new CommentSubscriptionCoordinator({
      scope: {
        accountId: account.id,
        platform: 'dev',
        source: normalizeCommentSource(config.source),
      },
      listener: platform,
      observeBusiness: () => {},
    })
  let lease: CommentSubscription | undefined

  async function execute() {
    let acquired: CommentSubscription | undefined
    try {
      if (config.ws) {
        wsService = new WebSocketService()
        // WebSocket 服务启动失败不会影响评论监听
        wsService.start(config.ws.port).catch(err => {
          wsService?.stop(err)
          wsService = null
        })
      }
      acquired = coordinator.acquire(
        { ...coordinator.scope, source: normalizeCommentSource(config.source) },
        { id: task.getTaskId(), onComment: broadcastMessage, listenerSource: config.source },
      )
      lease = acquired
      await acquired.ready
      if (!task.isRunning() || lease !== acquired) return
      logger.info('开始监听评论')
    } catch (err) {
      if (!task.isRunning() || (acquired && lease !== acquired)) return
      // 失败了还要告诉渲染层关闭按钮
      windowManager.send(IPC_CHANNELS.tasks.autoReply.listenerStopped, account.id)
      task.stop(TaskStopReason.ERROR, err)
    }
  }

  function broadcastMessage(message: LiveMessage) {
    const comment: LiveMessage = {
      ...message,
      time: Date.now(),
    }
    emitter.emit('live-comment', { accountId: account.id, comment })
    windowManager.send(IPC_CHANNELS.tasks.autoReply.showComment, {
      accountId: account.id,
      comment: comment,
    })

    wsService?.broadcast(comment)
  }

  function updateConfig(cfg: Partial<CommentListenerConfig>) {
    if (cfg.source && cfg.source !== config.source) {
      try {
        coordinator.assertCanReplace(
          { ...coordinator.scope, source: normalizeCommentSource(cfg.source) },
          task.getTaskId(),
        )
      } catch (error) {
        return Result.fail(error instanceof Error ? error : new Error('监听来源冲突'))
      }
    }
    if (cfg.ws && cfg.ws.port !== config.ws?.port) {
      config.ws = cfg.ws
      if (!wsService) {
        wsService = new WebSocketService()
      }
      wsService.stop()
      wsService.start(config.ws.port).catch(err => {
        wsService?.stop(err)
        wsService = null
      })
    }
    if (cfg.source && config.source !== cfg.source) {
      config.source = cfg.source
      lease?.release().catch(() => logger.warn('旧监听订阅释放失败'))
      lease = coordinator.acquire(
        { ...coordinator.scope, source: normalizeCommentSource(cfg.source) },
        { id: task.getTaskId(), onComment: broadcastMessage, listenerSource: cfg.source },
      )
      const updatedLease = lease
      updatedLease.ready.catch(error => {
        if (task.isRunning() && lease === updatedLease) task.stop(TaskStopReason.ERROR, error)
      })
    }
    return Result.succeed()
  }

  const task = createTask(
    {
      taskName: TASK_NAME,
      logger,
    },
    {
      onStart: async () => {
        await execute()
      },
      onStop: () => {
        emitter.emit('comment-listener-stopped', { accountId: account.id })
        lease?.release().catch(() => logger.warn('监听订阅释放失败'))
        wsService?.stop()
        wsService = null
      },
    },
  )

  return Result.succeed({
    ...task,
    updateConfig,
  })
}
