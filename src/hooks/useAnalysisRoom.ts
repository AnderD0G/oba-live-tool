import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { AnalysisCommand, AnalysisResponse, AnalysisScope } from '../../shared/analysisRoom'
import {
  createAnalysisState,
  reduceAnalysisState,
  sameAnalysisScope,
} from '../pages/AnalysisRoom/analysisState'
import { useIpcListener } from './useIpc'
import { useLiveControlStore } from './useLiveControl'

export function useAnalysisRoom(accountId: string) {
  const platform = useLiveControlStore(s => s.contexts[accountId]?.platform ?? 'douyin')
  const connection = useLiveControlStore(s => s.contexts[accountId]?.isConnected)
  const [source, setSource] = useState<AnalysisScope['source']>('control')
  const current = useRef({ scope: { accountId, platform, source }, generation: 1 })
  const scope: AnalysisScope = { accountId, platform, source }
  if (!sameAnalysisScope(current.current.scope, scope))
    current.current = { scope, generation: current.current.generation + 1 }
  const generation = current.current.generation
  const [stored, dispatch] = useReducer(reduceAnalysisState, scope, s => createAnalysisState(s))
  const state =
    stored.generation === generation && sameAnalysisScope(stored.scope, scope)
      ? stored
      : createAnalysisState(scope, generation)
  const serial = useRef(0)
  const request = useCallback(
    async (command: AnalysisCommand): Promise<AnalysisResponse> => {
      const owner = { accountId, generation, action: command.action, requestId: ++serial.current }
      if (generation !== current.current.generation)
        return {
          ok: false,
          error: {
            code: 'ANALYSIS_UNAVAILABLE',
            message: '账号或来源已切换，请重新操作',
            retryable: true,
          },
          traceId: 'ui-stale-scope',
        }
      dispatch({ type: 'begin', ...owner })
      let response: AnalysisResponse
      try {
        response = await window.ipcRenderer.invoke(
          'analysisRoom:request',
          JSON.parse(JSON.stringify(command)),
        )
      } catch {
        response = {
          ok: false,
          error: {
            code: 'ANALYSIS_UNAVAILABLE',
            message: '本地服务暂不可用，请刷新后重试',
            retryable: true,
          },
          traceId: `ui-${crypto.randomUUID()}`,
        }
      }
      dispatch({ type: 'response', ...owner, response })
      if (generation !== current.current.generation)
        return {
          ok: false,
          error: { code: 'ANALYSIS_UNAVAILABLE', message: '已忽略旧账号响应', retryable: true },
          traceId: 'ui-stale-response',
        }
      return response
    },
    [accountId, generation],
  )
  const refresh = useCallback(() => {
    void request({ action: 'capabilities', params: { scope: current.current.scope } })
    void request({ action: 'sessions', params: { scope: current.current.scope, limit: 20 } })
  }, [request])
  useEffect(() => {
    dispatch({ type: 'scope', scope: current.current.scope, generation })
    refresh()
    void request({ action: 'mappings', params: { platform, source } })
    void request({ action: 'groups-get', params: { accountId } })
  }, [accountId, generation, platform, source, request, refresh])
  useEffect(() => {
    if (connection !== undefined)
      void request({ action: 'capabilities', params: { scope: current.current.scope } })
  }, [connection, request])
  useIpcListener('analysisRoom:changed', change =>
    dispatch({ type: 'changed', generation: current.current.generation, change }),
  )
  const capturing = state.session?.status === 'collecting' || state.session?.status === 'stopping'
  useEffect(() => {
    if (platform !== 'tiktok') return
    let inFlight = false
    const refreshTransports = async () => {
      if (inFlight) return
      inFlight = true
      try {
        await request({ action: 'capabilities', params: { scope: current.current.scope } })
      } finally {
        inFlight = false
      }
    }
    void refreshTransports()
    if (!capturing) return
    const timer = window.setInterval(refreshTransports, 2000)
    return () => window.clearInterval(timer)
  }, [capturing, platform, request])
  useEffect(() => {
    if (state.reloadDictionary) void request({ action: 'mappings', params: { platform, source } })
  }, [state.reloadDictionary, platform, source, request])
  useEffect(() => {
    if (state.reloadGroups) void request({ action: 'groups-get', params: { accountId } })
  }, [state.reloadGroups, accountId, request])
  return { state, dispatch, request, refresh, setSource }
}
export type AnalysisRoomController = ReturnType<typeof useAnalysisRoom>
