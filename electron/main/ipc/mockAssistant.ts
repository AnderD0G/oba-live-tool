import { app } from 'electron'
import type { AssistantAudiencePolicy } from '../../../shared/assistantAudiencePolicy'
import type {
  AssistantDeskCommand,
  AssistantDeskContext,
  AssistantDeskDependencies,
  AssistantDeskResult,
} from '../../../shared/assistantDesk'
import type { AssistantReplyPolicy } from '../../../shared/assistantReplyPolicy'
import { IPC_CHANNELS } from '../../../shared/ipcChannels'
import {
  type MockAssistantControlResult,
  validateMockAssistantCommand,
} from '../../../shared/mockAssistantControl'
import { accountManager } from '../managers/AccountManager'
import { AssistantDeskService } from '../services/assistantDesk/AssistantDeskService'
import { ManualMockReplyGate } from '../services/mockAssistant/ManualMockReplyGate'
import { MockApiServer } from '../services/mockAssistant/MockApiServer'
import { mockHookSettings } from '../services/mockAssistant/MockDefaultHooks'
import { MockEffectsBridge } from '../services/mockAssistant/MockEffectsBridge'
import { buildMockMetadata } from '../services/mockAssistant/MockMetadata'
import { MockRuntime } from '../services/mockAssistant/MockRuntime'
import { withAssistantSourceTransition } from '../services/mockAssistant/MockSourceBarrier'
import { ObsRecordingControl } from '../services/ObsRecordingControl'
import { ObsWebSocketClient } from '../services/ObsWebSocketClient'
import { typedIpcMainHandle } from '../utils/ipc'
import { registerAnalysisShutdown } from './analysisRoom'
import {
  getAssistantDesk,
  localAssistantTranslationState,
  translateLocalAssistant,
} from './assistantDesk'
import { assistantProviderModel, interpretAssistant, translateAssistantDraft } from './deepSeekAuto'
import { snapshotMockEffectGroups } from './effectGroups'
import { snapshotMockHookSettings } from './hooks'
import { getObsEffectService } from './obsEffect'

let runtime: MockRuntime | undefined
let access: MockApiServer | undefined
const effects = new Map<string, MockEffectsBridge>()
const requestedLocalEffects = new Map<string, boolean>()
const gate = new ManualMockReplyGate({
  currentRun: accountId => runtime?.status(accountId).runId,
  send: async (permit, text, signal) =>
    accountManager.accountSessions
      .get(permit.accountId)
      ?.sendManualAssistantReply(text, signal, permit) ?? false,
})

export function isMockAssistantSelected(accountId: string) {
  return runtime?.isSelected(accountId) === true
}
export async function mockAssistantMetadata(accountId: string) {
  const source = runtime?.peekService(accountId) ?? getAssistantDesk()
  const result = await source.execute({ action: 'policy-get', params: { accountId } })
  if (!result.ok) throw new Error(result.error.message)
  return buildMockMetadata({ accountId, policy: result.data as AssistantAudiencePolicy })
}
async function resetEffects(accountId: string) {
  const instance = effects.get(accountId)
  effects.delete(accountId)
  await instance?.close()
}
async function copyConfiguration(accountId: string, desk: AssistantDeskService) {
  for (const entry of [
    { read: 'context-get', save: 'context-save', key: 'context' },
    { read: 'policy-get', save: 'policy-save', key: 'policy' },
    { read: 'reply-policy-get', save: 'reply-policy-save', key: 'policy' },
  ] as const) {
    const source = await getAssistantDesk().execute({ action: entry.read, params: { accountId } })
    const target = await desk.execute({ action: entry.read, params: { accountId } })
    if (!source.ok || !target.ok) throw new Error('无法读取当前助播配置')
    const revision = (target.data as { revision: number }).revision
    const saved = await desk.execute(
      entry.save === 'context-save'
        ? {
            action: 'context-save',
            params: {
              accountId,
              expectedRevision: revision,
              context: { ...(source.data as AssistantDeskContext), revision },
            },
          }
        : entry.save === 'policy-save'
          ? {
              action: 'policy-save',
              params: {
                accountId,
                expectedRevision: revision,
                policy: { ...(source.data as AssistantAudiencePolicy), revision },
              },
            }
          : {
              action: 'reply-policy-save',
              params: {
                accountId,
                expectedRevision: revision,
                policy: { ...(source.data as AssistantReplyPolicy), revision },
              },
            },
    )
    if (!saved.ok) throw new Error(saved.error.message)
  }
}
export function getMockRuntime() {
  if (!runtime)
    runtime = new MockRuntime({
      getMetadataRevision: async accountId =>
        (await mockAssistantMetadata(accountId)).metadataRevision,
      onReset: async (accountId, reason) => {
        await resetEffects(accountId)
        if (reason === 'start' && requestedLocalEffects.has(accountId)) {
          const desk = runtime?.peekService(accountId)
          if (!desk) throw new Error('模拟实例已关闭')
          const current = await desk.execute({ action: 'context-get', params: { accountId } })
          if (!current.ok) throw new Error(current.error.message)
          const context = current.data as AssistantDeskContext
          const result = await desk.execute({
            action: 'context-save',
            params: {
              accountId,
              expectedRevision: context.revision,
              context: {
                ...context,
                localEffectsEnabled: requestedLocalEffects.get(accountId) === true,
              },
            },
          })
          if (!result.ok) throw new Error(result.error.message)
        }
      },
      createDesk: async (accountId, startCapture, { runId }) => {
        const recording = new ObsRecordingControl(new ObsWebSocketClient(), () =>
          getObsEffectService().getSettings(),
        )
        const deps: AssistantDeskDependencies = {
          interpret: interpretAssistant,
          translateDraft: translateAssistantDraft,
          model: assistantProviderModel,
          startCapture,
          send: (id, text, signal) => gate.send(id, text, signal),
          localTranslate: translateLocalAssistant,
          localTranslationState: localAssistantTranslationState,
          recording: (id, action) => recording.execute(id, action),
          onObservedPersisted: async (id, message, row) => {
            if (
              !runtime?.isSelected(id) ||
              runtime.status(id).phase !== 'running' ||
              runtime.status(id).runId !== runId
            )
              return
            const [context, triage] = await Promise.all([
              desk.execute({ action: 'context-get', params: { accountId: id } }),
              desk.classifyAudienceEvent(id, message),
            ])
            if (
              !context.ok ||
              runtime.status(id).phase !== 'running' ||
              runtime.status(id).runId !== runId
            )
              return
            let bridge = effects.get(id)
            if (!bridge) {
              bridge = new MockEffectsBridge({
                accountId: id,
                hooks: mockHookSettings(snapshotMockHookSettings()),
                obs: getObsEffectService().getSettings(),
                groupSnapshot: snapshotMockEffectGroups(id),
                overlayBaseUrl: () => 'http://127.0.0.1:17892/',
                policy: async () => {
                  const result = await desk.execute({
                    action: 'policy-get',
                    params: { accountId: id },
                  })
                  if (!result.ok) throw new Error(result.error.message)
                  return result.data as AssistantAudiencePolicy
                },
              })
              effects.set(id, bridge)
            }
            await bridge.dispatch(
              message,
              { ...row, triage },
              (context.data as AssistantDeskContext).localEffectsEnabled === true,
            )
          },
        }
        const desk = new AssistantDeskService('', deps, {
          storage: 'memory',
          manualOnly: true,
          provenance: { mode: 'mock', runId },
        })
        try {
          await copyConfiguration(accountId, desk)
          return desk
        } catch (error) {
          await desk.shutdown()
          throw error
        }
      },
    })
  return runtime
}

/** API/MCP calls cannot turn a simulated draft into a public message. */
export async function executeMockDeskCommand(
  command: AssistantDeskCommand,
  origin: 'api' | 'desktop' | 'mobile',
): Promise<AssistantDeskResult> {
  if (command.action === 'start' || command.action === 'test-send')
    return {
      ok: false,
      error: {
        code: 'MOCK_USE_CONTROLS',
        message: '请在电脑模拟面板开始；真实发送请在具体草稿上手动确认',
      },
    }
  const accountId = command.params.accountId
  const instance = getMockRuntime()
  const desk = await instance.serviceFor(accountId)
  if (command.action === 'stop') {
    await instance.stop(accountId)
    return { ok: true, data: instance.status(accountId) }
  }
  if (command.action === 'state') {
    const result = await desk.execute(command)
    if (!result.ok) return result
    const selected = await accountManager.accountSessions.get(accountId)?.getPlatformSessionState()
    const ready =
      !!selected?.target &&
      !!selected.sessionId &&
      selected.loginStatus === 'authenticated' &&
      selected.roomReady &&
      !selected.busy
    return {
      ok: true,
      data: {
        ...(result.data as object),
        mockReplyTarget: {
          ready,
          ...(selected?.target ? { username: selected.target.username } : {}),
        },
      },
    }
  }
  if (command.action !== 'reply-approve') return desk.execute(command)
  if (origin === 'api')
    return {
      ok: false,
      error: { code: 'MOCK_MANUAL_SEND_REQUIRED', message: '模拟回复须在电脑或手机上手动点击发送' },
    }
  const session = accountManager.accountSessions.get(accountId)
  const selected = await session?.getPlatformSessionState()
  const runId = instance.status(accountId).runId
  if (
    !session ||
    !selected?.sessionId ||
    !selected.target ||
    selected.busy ||
    !selected.roomReady ||
    selected.loginStatus !== 'authenticated' ||
    !runId
  )
    return {
      ok: false,
      error: {
        code: 'MOCK_REAL_ROOM_REQUIRED',
        message: '请先登录并选择真实直播间，再手动发送；可以是自己的直播间',
      },
    }
  return gate.approve(
    {
      accountId,
      runId,
      rowId: command.params.rowId,
      requestId: command.params.requestId,
      expectedText: command.params.expectedText,
      sessionId: selected.sessionId,
      target: selected.target,
    },
    () => desk.execute(command),
  )
}

export async function executeMockAssistantCommand(
  input: unknown,
): Promise<MockAssistantControlResult> {
  try {
    const command = validateMockAssistantCommand(input)
    const { accountId } = command
    const instance = getMockRuntime()
    if (command.action === 'metadata')
      return { ok: true, data: await mockAssistantMetadata(accountId) }
    await withAssistantSourceTransition(accountId, async () => {
      if (command.action === 'prepare') await instance.prepare(accountId, command.batch)
      if (command.action === 'start') {
        const real = await getAssistantDesk().execute({ action: 'state', params: { accountId } })
        if (!real.ok) throw new Error(real.error.message)
        const active = (real.data as { activeSession?: { endedAt?: number } }).activeSession
        if (active && active.endedAt === undefined)
          throw new Error('请先停止真实直播采集，再开始模拟')
        if (typeof command.playLocalEffects === 'boolean')
          requestedLocalEffects.set(accountId, command.playLocalEffects)
        try {
          await instance.start(accountId)
        } finally {
          requestedLocalEffects.delete(accountId)
        }
      }
      if (command.action === 'stop') await instance.stop(accountId)
      if (command.action === 'clear') await instance.clear(accountId)
      if (command.action === 'leave') {
        await instance.leave(accountId)
        await revokeMockWorkerAccess()
      }
      if (command.action === 'api-stop') {
        await access?.close()
        access = undefined
      }
      if (command.action === 'api-start') {
        if (access?.status().accountId !== accountId) {
          await access?.close()
          access = undefined
        }
        access ??= new MockApiServer({
          accountId,
          host: '0.0.0.0',
          port: 18767,
          metadata: () => mockAssistantMetadata(accountId),
          status: () => instance.status(accountId),
          prepare: batch =>
            withAssistantSourceTransition(accountId, () => instance.prepare(accountId, batch)),
        })
        await access.start()
      }
    })
    return {
      ok: true,
      data: {
        runtime: instance.status(accountId),
        access:
          access?.status().accountId === accountId
            ? access.status()
            : { active: false, accountId, urls: [] },
      },
    }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'MOCK_OPERATION_FAILED',
        message: error instanceof Error ? error.message : '模拟操作失败',
      },
    }
  }
}
export async function revokeMockWorkerAccess() {
  await access?.close()
  access = undefined
}
export function setupMockAssistantIpc() {
  typedIpcMainHandle(IPC_CHANNELS.mockAssistant.request, (_event, command) =>
    executeMockAssistantCommand(command),
  )
  registerAnalysisShutdown(async () => {
    await revokeMockWorkerAccess()
    await runtime?.shutdown()
    await Promise.allSettled([...effects.keys()].map(resetEffects))
  })
  app.once('before-quit', () => {
    void revokeMockWorkerAccess()
  })
}
