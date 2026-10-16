import { AsyncResource } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import WebSocket, { type RawData } from 'ws'
import type { DirectorDiagnostics } from './DirectorDiagnostics'

type ObsMessage = {
  op: number
  d: Record<string, unknown>
}

type PendingRequest = {
  resolve: (data: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface ObsRpcClient {
  connect(url: string, password: string): Promise<void>
  call(requestType: string, requestData?: Record<string, unknown>): Promise<Record<string, unknown>>
  disconnect(): Promise<void>
}

export function createObsAuthentication(password: string, salt: string, challenge: string) {
  const secret = createHash('sha256')
    .update(password + salt)
    .digest('base64')
  return createHash('sha256')
    .update(secret + challenge)
    .digest('base64')
}

export class ObsWebSocketClient implements ObsRpcClient {
  constructor(
    private diagnostics?: DirectorDiagnostics,
    private diagnosticEvents = true,
  ) {}
  private socket: WebSocket | null = null
  private connectedUrl = ''
  private connectedPassword = ''
  private readonly pending = new Map<string, PendingRequest>()

  async connect(url: string, password: string) {
    if (
      this.socket?.readyState === WebSocket.OPEN &&
      this.connectedUrl === url &&
      this.connectedPassword === password
    ) {
      return
    }
    await this.disconnect()
    const socket = new WebSocket(url)
    this.socket = socket

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('连接 OBS 超时')), 8000)
      const cleanup = () => {
        clearTimeout(timer)
        socket.off('message', onMessage)
        socket.off('error', onError)
        socket.off('close', onClose)
      }
      const fail = (error: Error) => {
        cleanup()
        if (this.socket === socket) this.socket = null
        socket.close()
        reject(error)
      }
      const onError = (error: Error) => fail(error)
      const onClose = () => fail(new Error('OBS 在认证完成前断开连接'))
      const onMessage = (raw: RawData) => {
        try {
          const message = JSON.parse(raw.toString()) as ObsMessage
          if (message.op === 0) {
            const authentication = message.d.authentication as
              | { challenge?: string; salt?: string }
              | undefined
            if (authentication && !password) {
              fail(new Error('OBS WebSocket 已启用密码，请填写密码'))
              return
            }
            socket.send(
              JSON.stringify({
                op: 1,
                d: {
                  rpcVersion: 1,
                  eventSubscriptions: this.diagnostics && this.diagnosticEvents ? 256 : 0,
                  ...(authentication?.challenge && authentication.salt
                    ? {
                        authentication: createObsAuthentication(
                          password,
                          authentication.salt,
                          authentication.challenge,
                        ),
                      }
                    : {}),
                },
              }),
            )
          } else if (message.op === 2) {
            cleanup()
            this.connectedUrl = url
            this.connectedPassword = password
            socket.on('message', this.handleMessage)
            socket.on('close', this.handleClose)
            socket.on('error', this.handleError)
            resolve()
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error('OBS 返回了无效数据'))
        }
      }
      socket.on('message', onMessage)
      socket.once('error', onError)
      socket.once('close', onClose)
    })
  }

  private readonly handleMessage = (raw: RawData) => {
    let message: ObsMessage
    try {
      message = JSON.parse(raw.toString()) as ObsMessage
    } catch {
      return
    }
    if (message.op === 5) {
      this.diagnostics?.record('obs.event', message.d)
      return
    }
    if (message.op !== 7) return
    const requestId = String(message.d.requestId || '')
    const request = this.pending.get(requestId)
    if (!request) return
    clearTimeout(request.timer)
    this.pending.delete(requestId)
    const status = message.d.requestStatus as { result?: boolean; comment?: string; code?: number }
    if (!status?.result) {
      request.reject(
        new Error(status?.comment || `OBS 请求失败${status?.code ? `（${status.code}）` : ''}`),
      )
      return
    }
    request.resolve((message.d.responseData as Record<string, unknown>) || {})
  }

  private readonly handleClose = () => {
    this.socket = null
    this.rejectPending(new Error('OBS WebSocket 连接已断开'))
  }

  private readonly handleError = () => {
    this.rejectPending(new Error('OBS WebSocket 连接发生错误'))
  }

  call(requestType: string, requestData: Record<string, unknown> = {}) {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('OBS WebSocket 尚未连接'))
    }
    const requestId = randomUUID()
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`OBS 请求超时：${requestType}`))
      }, 8000)
      const diagnostics = this.diagnostics
      diagnostics?.record('obs.command', { requestType, requestId, ...requestData })
      this.pending.set(requestId, {
        resolve: AsyncResource.bind(data => {
          diagnostics?.record('obs.result', {
            requestType,
            requestId,
            inputName: requestData.inputName,
            ...data,
          })
          resolve(data)
        }),
        reject: AsyncResource.bind(error => {
          diagnostics?.record('obs.failure', { requestType, requestId })
          reject(error)
        }),
        timer,
      })
      socket.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }), error => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(error)
      })
    })
  }

  async disconnect() {
    const socket = this.socket
    this.socket = null
    this.connectedUrl = ''
    this.connectedPassword = ''
    this.rejectPending(new Error('OBS WebSocket 连接已关闭'))
    if (!socket) return
    socket.off('message', this.handleMessage)
    socket.off('close', this.handleClose)
    socket.off('error', this.handleError)
    if (socket.readyState === WebSocket.CLOSED) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 1000)
      socket.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.close()
    })
  }

  private rejectPending(error: Error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }
}
