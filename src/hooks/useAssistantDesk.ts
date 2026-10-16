import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AssistantDeskCommand,
  AssistantDeskResult,
  AssistantDeskState,
} from '../../shared/assistantDesk'
import type {
  PlatformLoginQrPreview,
  PlatformSessionCommand,
  PlatformSessionResult,
  PlatformSessionState,
} from '../../shared/platformSession'

interface DeskError {
  id: string
  code: string
  message: string
}
interface StoredDesk {
  accountId: string
  state?: AssistantDeskState
  platform?: PlatformSessionState
  platformWarning?: string
  qr?: PlatformLoginQrPreview
  errors: DeskError[]
  pending: Record<string, number>
}
const initial = (accountId: string): StoredDesk => ({ accountId, errors: [], pending: {} })
const stale = (): AssistantDeskResult => ({
  ok: false,
  error: { code: 'ACCOUNT_CHANGED', message: '账号已切换，请重新操作' },
})
const readActions = new Set([
  'state',
  'context-get',
  'timeline',
  'audience',
  'sessions',
  'segments',
  'segment-summary',
  'policy-fields',
  'policy-get',
  'policy-simulate',
  'attention-window',
  'message-batches',
  'message-batch',
])

export function useAssistantDesk(accountId: string) {
  const owner = useRef({ accountId, generation: 0 })
  if (owner.current.accountId !== accountId)
    owner.current = { accountId, generation: owner.current.generation + 1 }
  const generation = owner.current.generation
  const stateReadSerial = useRef(0)
  const platformReadSerial = useRef(0)
  const platformMutations = useRef({ generation, pending: 0 })
  if (platformMutations.current.generation !== generation)
    platformMutations.current = { generation, pending: 0 }
  const [stored, setStored] = useState<StoredDesk>(() => initial(accountId))
  const data = stored.accountId === accountId ? stored : initial(accountId)
  const patch = useCallback(
    (fn: (current: StoredDesk) => StoredDesk) => {
      if (owner.current.accountId !== accountId || owner.current.generation !== generation) return
      setStored(current => fn(current.accountId === accountId ? current : initial(accountId)))
    },
    [accountId, generation],
  )
  const pending = useCallback(
    (action: string, delta: number) =>
      patch(current => ({
        ...current,
        pending: {
          ...current.pending,
          [action]: Math.max(0, (current.pending[action] ?? 0) + delta),
        },
      })),
    [patch],
  )
  const reportError = useCallback(
    (error: { code: string; message: string }) =>
      patch(current => {
        if (current.errors.some(item => item.code === error.code && item.message === error.message))
          return current
        return {
          ...current,
          errors: [...current.errors.slice(-9), { ...error, id: crypto.randomUUID() }],
        }
      }),
    [patch],
  )
  const readState = useCallback(async (): Promise<AssistantDeskResult> => {
    if (owner.current.accountId !== accountId || owner.current.generation !== generation)
      return stale()
    const serial = ++stateReadSerial.current
    try {
      const response = await window.ipcRenderer.invoke('assistant-desk:request', {
        action: 'state',
        params: { accountId },
      })
      if (owner.current.accountId !== accountId || owner.current.generation !== generation)
        return stale()
      if (response.ok && serial === stateReadSerial.current)
        patch(current => ({ ...current, state: response.data as AssistantDeskState }))
      else if (!response.ok && serial === stateReadSerial.current) reportError(response.error)
      return response
    } catch (error) {
      const failure = {
        code: 'DESK_UNAVAILABLE',
        message: error instanceof Error ? error.message : '助播服务暂不可用',
      }
      if (serial === stateReadSerial.current) reportError(failure)
      return { ok: false, error: failure }
    }
  }, [accountId, generation, patch, reportError])
  const request = useCallback(
    async (command: AssistantDeskCommand): Promise<AssistantDeskResult> => {
      if (command.params.accountId !== accountId || owner.current.generation !== generation)
        return stale()
      pending(command.action, 1)
      try {
        if (command.action === 'state') return await readState()
        const response = await window.ipcRenderer.invoke('assistant-desk:request', command)
        if (owner.current.accountId !== accountId || owner.current.generation !== generation)
          return stale()
        if (!response.ok) reportError(response.error)
        else if (!readActions.has(command.action)) await readState()
        return response
      } catch (error) {
        const failure = {
          code: 'DESK_UNAVAILABLE',
          message: error instanceof Error ? error.message : '助播服务暂不可用',
        }
        reportError(failure)
        return { ok: false, error: failure }
      } finally {
        pending(command.action, -1)
      }
    },
    [accountId, generation, pending, readState, reportError],
  )
  const requestPlatform = useCallback(
    async (command: PlatformSessionCommand, automatic = false): Promise<PlatformSessionResult> => {
      if (command.accountId !== accountId || owner.current.generation !== generation)
        return { ok: false, error: { code: 'SESSION_CHANGED', message: '账号已切换，请重新操作' } }
      const action = `platform:${command.action}`
      const serial = command.action === 'qr-preview' ? undefined : ++platformReadSerial.current
      const mutation = !automatic && !['state', 'qr-preview'].includes(command.action)
        ? platformMutations.current : undefined
      if (mutation) mutation.pending++
      pending(action, 1)
      try {
        const response = await window.ipcRenderer.invoke('platform-session:request', command)
        if (owner.current.accountId !== accountId || owner.current.generation !== generation)
          return { ok: false, error: { code: 'SESSION_CHANGED', message: '已忽略旧账号响应' } }
        if (!response.ok) {
          if (serial === undefined || serial === platformReadSerial.current) {
            if (automatic) patch(current => ({ ...current, platformWarning: '登录状态检查未响应，不代表采集中断；当前保留上次确认的状态。' }))
            else reportError(response.error)
          }
        }
        else if (command.action === 'qr-preview')
          patch(current =>
            current.platform?.sessionId === command.sessionId &&
            current.platform.loginStatus !== 'authenticated'
              ? { ...current, qr: response.data as PlatformLoginQrPreview }
              : current,
          )
        else if (serial === platformReadSerial.current)
          patch(current => {
            const platform = response.data as PlatformSessionState
            return {
              ...current,
              platform,
              platformWarning: undefined,
              qr:
                platform.loginStatus === 'authenticated' ||
                platform.sessionId !== current.platform?.sessionId
                  ? undefined
                  : current.qr,
            }
          })
        return response
      } catch (error) {
        const failure = {
          code: 'OPERATION_FAILED' as const,
          message: error instanceof Error ? error.message : '登录会话暂不可用',
        }
        if (serial === undefined || serial === platformReadSerial.current) {
          if (automatic) patch(current => ({ ...current, platformWarning: '登录状态检查未响应，不代表采集中断；当前保留上次确认的状态。' }))
          else reportError(failure)
        }
        return { ok: false, error: failure }
      } finally {
        if (mutation) mutation.pending--
        pending(action, -1)
      }
    },
    [accountId, generation, pending, patch, reportError],
  )
  const platformRequest = useCallback(
    (command: PlatformSessionCommand) => requestPlatform(command),
    [requestPlatform],
  )
  const refresh = useCallback(async () => {
    await Promise.all([readState(), platformRequest({ action: 'state', accountId })])
  }, [accountId, readState, platformRequest])
  useEffect(() => {
    let disposed = false
    let dataInFlight = false
    let platformInFlight = false
    const pollData = async () => {
      if (disposed || dataInFlight) return
      dataInFlight = true
      try {
        await readState()
      } finally {
        dataInFlight = false
      }
    }
    const pollPlatform = async () => {
      if (disposed || platformInFlight || platformMutations.current.pending > 0) return
      platformInFlight = true
      try {
        await requestPlatform({ action: 'state', accountId }, true)
      } finally {
        platformInFlight = false
      }
    }
    void pollData()
    void pollPlatform()
    const dataTimer = window.setInterval(() => void pollData(), 2000)
    const platformTimer = window.setInterval(() => void pollPlatform(), 15000)
    return () => {
      disposed = true
      window.clearInterval(dataTimer)
      window.clearInterval(platformTimer)
    }
  }, [accountId, readState, requestPlatform])
  const dismissError = useCallback(
    (id: string) =>
      patch(current => ({ ...current, errors: current.errors.filter(item => item.id !== id) })),
    [patch],
  )
  const busy = Object.entries(data.pending).some(
    ([action, count]) => count > 0 && action !== 'state' && action !== 'platform:state',
  )
  return { ...data, accountId, request, platformRequest, refresh, dismissError, busy }
}
export type AssistantDeskController = ReturnType<typeof useAssistantDesk>
