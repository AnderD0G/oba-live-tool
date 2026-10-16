import { createServer, type Server } from 'node:http'
import type { HookEngine } from './HookEngine'

const MAX_BODY_BYTES = 1024 * 1024

export class LocalHookServer {
  private server: Server | null = null
  private port: number | null = null

  constructor(private readonly engine: HookEngine) {}

  getPort() {
    const address = this.server?.address()
    return address && typeof address === 'object' ? address.port : null
  }

  async start(port: number) {
    if (this.server && this.port === port) return
    await this.stop()
    const server = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      if (request.method !== 'POST') {
        response.statusCode = 405
        response.end(JSON.stringify({ ok: false, error: '仅支持 POST 请求' }))
        return
      }
      const match = request.url?.match(/^\/hooks\/([^/?#]+)$/)
      if (!match) {
        response.statusCode = 404
        response.end(JSON.stringify({ ok: false, error: '路径应为 /hooks/{事件名称}' }))
        return
      }
      try {
        const payload = await readJsonBody(request)
        const eventName = decodeURIComponent(match[1])
        const matchedRules = await this.engine.dispatch(this.engine.fromWebhook(eventName, payload))
        response.statusCode = 200
        response.end(JSON.stringify({ ok: true, matchedRules }))
      } catch (error) {
        response.statusCode = 400
        response.end(
          JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : 'Webhook 请求失败',
          }),
        )
      }
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
    this.port = port
  }

  async stop() {
    const server = this.server
    this.server = null
    this.port = null
    if (!server) return
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    )
  }
}

async function readJsonBody(request: NodeJS.ReadableStream) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('请求内容不能超过 1 MB')
    chunks.push(buffer)
  }
  if (!chunks.length) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('请求正文必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}
