import { randomUUID } from 'node:crypto'
import type { CDPSession, Page, Response } from 'playwright'
import { createLogger } from '#/logger'
import type { BusinessSourceObservation } from '../IPlatform'
import { decodeXiaohongshuBusinessFrame } from './businessFrame'
import { mapXiaohongshuMessage } from './messages'

interface WebSocketFrameReceivedEvent {
  requestId: string
  timestamp: number
  response: {
    opcode: number
    mask: boolean
    payloadData: string // 就你要的
  }
}

interface XiaohongshuSendCommentResponse {
  data: {
    comment: string
    common_response: {
      common_result: number
      toast: string
    }
    profile: {
      user_id: string
    }
  }
  code: number
  success: boolean
}

export class XiaohongshuCommentListener {
  private client: CDPSession | null = null
  private accountName = ''
  private handleComment: (comment: LiveMessage) => void = () => {}
  private readonly streamId = randomUUID()
  private sequence = 0
  private stopped = false

  constructor(
    private page: Page,
    private observeBusiness: (observation: BusinessSourceObservation) => void = () => {},
  ) {
    this.handleWebSocketResponse = this.handleWebSocketResponse.bind(this)
    this.handleResponse = this.handleResponse.bind(this)
  }

  private async getCDPSession() {
    const context = this.page.context()
    return await context.newCDPSession(this.page)
  }

  async startCommentListener(onComment: (comment: LiveMessage) => void): Promise<void> {
    this.stopped = false
    if (!this.client) {
      this.client = await this.getCDPSession()
    }
    this.handleComment = onComment
    await this.client.send('Network.enable')
    if (this.stopped) return
    this.client.on('Network.webSocketFrameReceived', this.handleWebSocketResponse)
    // 还有主动发送的消息，不会通过 WebSocket
    this.page.on('response', this.handleResponse)
  }

  private async handleResponse(response: Response) {
    const url = response.url()
    if (!url.includes('send_comment')) return
    const respJson = (await response.json()) as XiaohongshuSendCommentResponse
    createLogger('千帆发送回执').info(
      JSON.stringify({
        httpStatus: response.status(),
        method: response.request().method(),
        success: respJson.success,
        code: respJson.code,
        commonResult: respJson.data?.common_response?.common_result,
        commentLength: respJson.data?.comment?.length,
      }),
    )
    if (respJson.success) {
      const data = respJson.data
      const liveMessage: LiveMessage = {
        msg_type: 'xiaohongshu_comment',
        msg_id: crypto.randomUUID(), // 主动发送的没有 commentId
        is_self: true,
        nick_name: this.accountName ?? '',
        user_id: data.profile.user_id,
        content: data.comment,
        time: Date.now(),
      }
      this.handleComment(liveMessage)
    }
  }

  private async handleWebSocketResponse({ response }: WebSocketFrameReceivedEvent) {
    if (this.stopped) return
    const decoded = decodeXiaohongshuBusinessFrame(response.payloadData)
    for (const content of decoded.contents) {
      const data = content.payload.data
      const type =
        data && typeof data === 'object' && !Array.isArray(data) && typeof data.type === 'string'
          ? data.type.slice(0, 128)
          : undefined
      const receivedAt = Date.now()
      const platformTime =
        content.envelope.ts >= 1000000000000 && content.envelope.ts <= receivedAt + 86400000
          ? content.envelope.ts
          : undefined
      const observation: BusinessSourceObservation = {
        ...content.payload,
        observationId: randomUUID(),
        streamId: this.streamId,
        sequence: ++this.sequence,
        receivedAt,
        formatVersion: 1,
        ...(platformTime === undefined ? {} : { platformTime }),
        ...(content.envelope.msgId ? { sourceMessageId: content.envelope.msgId } : {}),
        ...(content.envelope.roomId ? { roomId: content.envelope.roomId } : {}),
        ...(type ? { businessType: type } : {}),
        ...(content.failureCode ? { failureCode: content.failureCode } : {}),
      }
      try {
        this.observeBusiness(observation)
      } catch {
        /* Observers cannot break normalized monitoring. */
      }
      if (content.failureCode) continue
      try {
        const message = mapXiaohongshuMessage(data, content.envelope)
        if (message) this.handleComment(message)
      } catch {
        /* A malformed business item or one consumer cannot discard its siblings. */
      }
    }
  }

  public setAccountName(accountName: string) {
    this.accountName = accountName
  }

  async stopCommentListener(): Promise<void> {
    this.stopped = true
    const client = this.client
    client?.off('Network.webSocketFrameReceived', this.handleWebSocketResponse)
    this.page.off('response', this.handleResponse)
    this.client = null
    await client?.send('Network.disable').catch(() => {})
    await client?.detach().catch(() => {})
  }
  getCommentListenerPage(): Page {
    return this.page
  }
}
