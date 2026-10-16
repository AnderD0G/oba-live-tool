import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { type AddressInfo, isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import {
  MOCK_LIMITS,
  type MockApiAccessStatus,
  type MockBatch,
  MockBatchValidationError,
  type MockRuntimeStatus,
  validateMockBatch,
} from '../../../../shared/mockAssistant'
import { MOCK_API_OVERVIEW, mockApiOpenApi } from './MockApiDocumentation'
import { buildMockMetadata, type MockMetadata } from './MockMetadata'

export interface MockApiServerOptions {
  accountId: string
  host?: '127.0.0.1' | '0.0.0.0'
  port?: number
  networkAddresses?: () => string[]
  metadata(): MockMetadata | Promise<MockMetadata>
  status(): MockRuntimeStatus | Promise<MockRuntimeStatus>
  prepare(batch: MockBatch): MockRuntimeStatus | Promise<MockRuntimeStatus>
}
export class MockApiServer {
  private server?: Server
  private starting?: Promise<MockApiAccessStatus>
  private token?: string
  private urls: string[] = []
  private generation = 0

  constructor(private options: MockApiServerOptions) {
    if (
      !/^[^\s\p{Cc}]{1,256}$/u.test(options.accountId) ||
      !['127.0.0.1', '0.0.0.0'].includes(options.host ?? '127.0.0.1') ||
      !Number.isInteger(options.port ?? 0) ||
      (options.port ?? 0) < 0 ||
      (options.port ?? 0) > 65535
    )
      throw new Error('Invalid Mock API scope or listener')
  }

  status(): MockApiAccessStatus {
    const active = !!this.token && this.server?.listening === true
    return {
      active,
      accountId: this.options.accountId,
      urls: active ? [...this.urls] : [],
      ...(active ? { token: this.token } : {}),
    }
  }

  start(): Promise<MockApiAccessStatus> {
    if (this.starting) return this.starting
    if (this.status().active) return Promise.resolve(this.status())
    const generation = ++this.generation
    const operation = this.open(generation)
    this.starting = operation
    void operation.then(
      () => {
        if (this.starting === operation) this.starting = undefined
      },
      () => {
        if (this.starting === operation) this.starting = undefined
      },
    )
    return operation
  }

  private async open(generation: number): Promise<MockApiAccessStatus> {
    const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
      // A client may disconnect after a rejected/oversized upload has already settled.
      request.on('error', () => {})
      response.on('error', () => {})
      void this.handle(request, response).catch(error => {
        if (response.destroyed || response.writableEnded) return
        request.resume()
        if (error instanceof MockBatchValidationError) {
          const status =
            error.code === 'MOCK_ACCOUNT_MISMATCH'
              ? 403
              : error.code === 'MOCK_METADATA_STALE'
                ? 409
                : error.code === 'MOCK_BATCH_TOO_LARGE'
                  ? 413
                  : 400
          send(response, status, { ok: false, error: { code: error.code, message: error.message } })
        } else if (error instanceof HttpError)
          send(response, error.status, {
            ok: false,
            error: { code: error.code, message: error.message },
          })
        else
          send(response, 500, {
            ok: false,
            error: { code: 'MOCK_API_FAILED', message: '模拟入口暂时不可用，请在桌面检查' },
          })
      })
    })
    server.requestTimeout = 15_000
    server.headersTimeout = 10_000
    server.keepAliveTimeout = 1000
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => {
          server.off('listening', listening)
          reject(error)
        }
        const listening = () => {
          server.off('error', failed)
          resolve()
        }
        server.once('error', failed)
        server.once('listening', listening)
        server.listen(this.options.port ?? 0, this.options.host ?? '127.0.0.1')
      })
      if (generation !== this.generation) throw new Error('Mock API start revoked')
      const port = (server.address() as AddressInfo).port
      const addresses =
        this.options.host === '0.0.0.0'
          ? (this.options.networkAddresses?.() ??
            Object.values(networkInterfaces()).flatMap(values =>
              (values ?? [])
                .filter(value => !value.internal && value.family === 'IPv4')
                .map(value => value.address),
            ))
          : []
      this.urls = [...new Set(['127.0.0.1', ...addresses.filter(privateIPv4)])].map(
        address => `http://${address}:${port}`,
      )
      this.token = randomBytes(32).toString('base64url')
      return this.status()
    } catch (error) {
      if (this.server === server) {
        this.server = undefined
        this.token = undefined
        this.urls = []
      }
      await closeServer(server)
      throw error
    }
  }

  async close(): Promise<void> {
    this.generation++
    this.token = undefined
    this.urls = []
    const server = this.server
    this.server = undefined
    await closeServer(server)
    await this.starting?.catch(() => undefined)
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    if (!request.url?.startsWith('/') || request.url.startsWith('//'))
      throw new HttpError(400, 'MOCK_INVALID_ROUTE', '请求路径无效')
    if (
      !this.urls.some(url => new URL(url).host === request.headers.host) ||
      request.headers.origin !== undefined
    )
      throw new HttpError(403, 'MOCK_FORBIDDEN', '请求来源无效')
    const url = new URL(request.url, this.urls[0])
    if (url.search)
      throw new HttpError(400, 'MOCK_INVALID_ROUTE', '请通过请求头提供密钥，不使用查询参数')
    if (request.method === 'GET' && url.pathname === '/mock/openapi.json')
      return send(response, 200, mockApiOpenApi())
    if (request.method === 'GET' && ['/mock/overview', '/mock/docs'].includes(url.pathname))
      return send(response, 200, MOCK_API_OVERVIEW)
    const routes = { '/mock/metadata': 'GET', '/mock/status': 'GET', '/mock/batches': 'POST' }
    if (!(url.pathname in routes) || request.method !== routes[url.pathname as keyof typeof routes])
      throw new HttpError(404, 'MOCK_NOT_FOUND', '模拟入口没有此操作')
    const authorization = request.headers.authorization
    const expected = this.token ? Buffer.from(`Bearer ${this.token}`) : undefined
    const actual = typeof authorization === 'string' ? Buffer.from(authorization) : undefined
    if (
      !expected ||
      !actual ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      throw new HttpError(401, 'MOCK_UNAUTHORIZED', '模拟入口密钥无效或已撤销')
    const generation = this.generation
    const current = () => {
      if (generation !== this.generation || !this.token || request.aborted || response.destroyed)
        throw new HttpError(403, 'MOCK_ACCESS_REVOKED', '模拟入口已关闭或账号已切换')
    }
    // Preparation is permitted before playback selection; only the bound account is required.
    const runtime = await this.options.status()
    current()
    if (runtime.accountId !== this.options.accountId) {
      response.once('finish', () => {
        void this.close()
      })
      throw new HttpError(403, 'MOCK_ACCOUNT_CHANGED', '请在当前模拟账号重新开启入口')
    }
    if (url.pathname === '/mock/status')
      return send(response, 200, { ok: true, data: projectStatus(runtime, this.options.accountId) })
    if (url.pathname === '/mock/metadata') {
      const metadata = await this.metadata()
      current()
      return send(response, 200, { ok: true, data: metadata })
    }
    if (
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')
    )
      throw new HttpError(415, 'MOCK_CONTENT_TYPE', '请上传application/json格式')
    const body = await readBody(request)
    current()
    const metadata = await this.metadata()
    current()
    const batch = validateMockBatch(body, this.options.accountId, metadata.metadataRevision)
    // No route exposes playback, capture, real replies, configuration or Director authority.
    const prepared = await this.options.prepare(batch)
    current()
    return send(response, 201, { ok: true, data: projectStatus(prepared, this.options.accountId) })
  }

  private async metadata(): Promise<MockMetadata> {
    const metadata = await this.options.metadata()
    if (metadata.accountId !== this.options.accountId)
      throw new HttpError(403, 'MOCK_ACCOUNT_CHANGED', '模拟账号已切换')
    // Rebuild the whitelist projection defensively, ignoring any additional facade fields.
    return buildMockMetadata({ accountId: metadata.accountId, policy: metadata.policy })
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'Content-Type':
      typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  })
  response.end(typeof body === 'string' ? body : JSON.stringify(body))
}
function privateIPv4(address: string) {
  if (isIP(address) !== 4) return false
  const [first, second] = address.split('.').map(Number)
  return (
    first === 10 ||
    (first === 192 && second === 168) ||
    (first === 172 && second >= 16 && second <= 31)
  )
}
function closeServer(server?: Server): Promise<void> {
  if (!server?.listening) return Promise.resolve()
  server.closeAllConnections()
  return new Promise(resolve => {
    server.close(() => resolve())
  })
}
function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false
    let size = 0
    const chunks: Buffer[] = []
    const cleanup = () => {
      clearTimeout(timer)
      request.off('data', data)
      request.off('end', end)
      request.off('error', failed)
      request.off('aborted', aborted)
    }
    const failed = (error: unknown) => {
      if (!settled) {
        settled = true
        cleanup()
        reject(error)
      }
    }
    const aborted = () =>
      failed(new HttpError(400, 'MOCK_UPLOAD_ABORTED', '上传已中断，批次未准备'))
    const data = (chunk: Buffer) => {
      size += chunk.length
      if (size > MOCK_LIMITS.maxBodyBytes) {
        failed(new HttpError(413, 'MOCK_BATCH_TOO_LARGE', '模拟批次超过2MB上限'))
        request.resume()
      } else chunks.push(chunk)
    }
    const end = () => {
      if (settled) return
      settled = true
      cleanup()
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new HttpError(400, 'MOCK_INVALID_JSON', '上传内容不是有效JSON'))
      }
    }
    const timer = setTimeout(() => {
      failed(new HttpError(408, 'MOCK_UPLOAD_TIMEOUT', '上传超时，批次未准备'))
      request.resume()
    }, 10_000)
    request.on('data', data)
    request.once('end', end)
    request.once('error', failed)
    request.once('aborted', aborted)
    const length = request.headers['content-length']
    if (length !== undefined && Number(length) > MOCK_LIMITS.maxBodyBytes) {
      failed(new HttpError(413, 'MOCK_BATCH_TOO_LARGE', '模拟批次超过2MB上限'))
      request.resume()
    }
  })
}
function projectStatus(status: MockRuntimeStatus, accountId: string): MockRuntimeStatus {
  if (
    status.accountId !== accountId ||
    !['idle', 'prepared', 'running', 'stopped'].includes(status.phase) ||
    !Number.isSafeInteger(status.emitted) ||
    status.emitted < 0
  )
    throw new Error('Invalid Mock status')
  return {
    accountId,
    selected: status.selected === true,
    phase: status.phase,
    volatile: true,
    emitted: status.emitted,
    ...(status.runId ? { runId: status.runId } : {}),
    ...(status.batch
      ? {
          batch: {
            batchId: status.batch.batchId,
            name: status.batch.name,
            metadataRevision: status.batch.metadataRevision,
            userCount: status.batch.userCount,
            eventCount: status.batch.eventCount,
            durationMs: status.batch.durationMs,
          },
        }
      : {}),
    ...(status.error
      ? {
          error: {
            code: /^MOCK_[A-Z0-9_]{1,60}$/.test(status.error.code)
              ? status.error.code
              : 'MOCK_RUNTIME_FAILED',
            message: '模拟运行需要检查，请在桌面查看详情',
          },
        }
      : {}),
  }
}
