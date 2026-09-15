import { app, session } from 'electron'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { emitter } from '#/event/eventBus'
import { accountManager } from '#/managers/AccountManager'
import { CodexAutoReplyService } from '#/services/CodexAutoReplyService'
import { validateRequest } from '#/services/CodexDraftService'
import { codexProxyEnvironment } from '#/services/codexProxy'
import { configuredVoiceTokenPath, LocalVoiceClient } from '#/services/LocalVoiceClient'
import { PersistentCodexDraftService } from '#/services/PersistentCodexDraftService'
import { typedIpcMainHandle } from '#/utils'
import windowManager from '#/windowManager'
import { setupCommentCatcher } from './commentCatcher'
import { setupEnvironmentIpc } from './setup'

export function setupCodexDraftIpcHandlers() {
  const service = new PersistentCodexDraftService(async () => {
    const proxy = await session.defaultSession.resolveProxy('https://chatgpt.com')
    return codexProxyEnvironment(proxy, process.env)
  })
  const owners = new Set<number>()
  setupEnvironmentIpc(service)
  setupCommentCatcher(service)
  const autoOwner = -100
  const autoOwners = new Set<number>()
  const voice = new LocalVoiceClient(() => configuredVoiceTokenPath(app.getPath('userData')))
  const auto = new CodexAutoReplyService({
    ready: id => accountManager.accountSessions.get(id)?.codexAutoReady() ?? false,
    hostName: id => accountManager.accountSessions.get(id)?.getLiveAccountName() ?? '',
    busy: () => service.isBusy,
    generate: (request, progress) => service.generate(autoOwner, request, progress),
    cancel: () => {
      service.cancel(autoOwner)
    },
    send: async (id, text, signal) =>
      accountManager.accountSessions.get(id)?.sendCodexReply(text, signal) ?? false,
    speak: (accountId, commentId, text, signal, progress) =>
      voice.speak(accountId, commentId, text, signal, progress),
    changed: state => windowManager.send(IPC_CHANNELS.codexAuto.changed, state),
  })
  emitter.on('live-comment', ({ accountId, comment }) => auto.comment(accountId, comment))
  emitter.on('comment-listener-stopped', ({ accountId }) => auto.disconnected(accountId))
  let quitting = false
  app.on('before-quit', event => {
    auto.disable('应用已关闭')
    if (!quitting && voice.isActive) {
      event.preventDefault()
      quitting = true
      void voice
        .cancelActive()
        .catch(() => {})
        .finally(() => {
          service.dispose()
          app.quit()
        })
    }
  })
  typedIpcMainHandle(IPC_CHANNELS.codexAuto.state, () => auto.snapshot())
  typedIpcMainHandle(IPC_CHANNELS.codexAuto.voiceStatus, () => voice.check())
  typedIpcMainHandle(IPC_CHANNELS.codexAuto.configure, async (event, settings) => {
    try {
      if (
        !settings ||
        typeof settings.accountId !== 'string' ||
        typeof settings.enabled !== 'boolean'
      )
        throw new Error('无效设置')
      if (!settings.enabled) {
        auto.disable()
        return { ok: true }
      }
      if (
        settings.delivery !== undefined &&
        settings.delivery !== 'text' &&
        settings.delivery !== 'voice'
      )
        throw new Error('无效回复模式')
      if (settings.delivery === 'voice') {
        const connection = await voice.check()
        if (!connection.ok) throw new Error(connection.message)
      }
      validateRequest({
        requestId: 'auto-settings',
        comment: '验证配置',
        instructions: settings.instructions,
        model: settings.model,
      })
      if (
        settings.instructions.length > 5800 ||
        (settings.blockList &&
          (!Array.isArray(settings.blockList) ||
            settings.blockList.length > 1000 ||
            settings.blockList.some(name => typeof name !== 'string')))
      )
        throw new Error('回复要求或屏蔽列表过长')
      const status = await service.status()
      if (!status.available) throw new Error(status.error)
      auto.enable(settings)
      if (!autoOwners.has(event.sender.id)) {
        autoOwners.add(event.sender.id)
        event.sender.once('destroyed', () => {
          autoOwners.delete(event.sender.id)
          auto.disable('窗口已关闭')
        })
        event.sender.on('render-process-gone', () => auto.disable('界面已断开'))
        event.sender.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
          if (isMainFrame) auto.disable('界面已重新加载，请重新开启')
        })
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '开启失败' }
    }
  })
  app.once('before-quit', () => service.dispose())
  void app.whenReady().then(() => service.status())
  typedIpcMainHandle(IPC_CHANNELS.codexDraft.status, () => service.status())
  typedIpcMainHandle(IPC_CHANNELS.codexDraft.generate, (event, request) => {
    const owner = event.sender.id
    if (!owners.has(owner)) {
      owners.add(owner)
      event.sender.once('destroyed', () => {
        service.cancel(owner)
        owners.delete(owner)
      })
    }
    return service.generate(owner, request, progress => {
      if (!event.sender.isDestroyed())
        event.sender.send(IPC_CHANNELS.codexDraft.progress, {
          requestId: request.requestId,
          ...progress,
        })
    })
  })
  typedIpcMainHandle(IPC_CHANNELS.codexDraft.cancel, (event, id) =>
    service.cancel(event.sender.id, id),
  )
}
