import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import test, { type TestContext } from 'node:test'
import type { mockApiOpenApi } from '../electron/main/services/mockAssistant/MockApiDocumentation'
import { MockApiServer } from '../electron/main/services/mockAssistant/MockApiServer'
import {
  buildMockMetadata,
  type MockMetadata,
} from '../electron/main/services/mockAssistant/MockMetadata'
import { defaultAudiencePolicy } from '../shared/assistantAudiencePolicy'
import type { MockRuntimeStatus } from '../shared/mockAssistant'

async function fixture(t: TestContext, selected = true) {
  let policy = defaultAudiencePolicy()
  let metadataWait: Promise<void> | undefined
  const prepared: unknown[] = []
  const status: MockRuntimeStatus = {
    accountId: 'default',
    selected,
    phase: 'idle',
    volatile: true,
    emitted: 0,
  }
  const server = new MockApiServer({
    accountId: 'default',
    host: '127.0.0.1',
    port: 0,
    metadata: async () => {
      await metadataWait
      return buildMockMetadata({ accountId: 'default', policy })
    },
    status: () => ({ ...status, apiKey: 'PRIVATE-STATUS-KEY' }),
    prepare: async value => {
      prepared.push(value)
      return { ...status, phase: 'prepared' }
    },
  })
  assert.equal(server.status().active, false)
  const access = await server.start()
  t.after(() => server.close())
  const request = (
    path: string,
    options: {
      method?: string
      body?: unknown
      token?: string
      headers?: Record<string, string>
    } = {},
  ) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: unknown; text: string }>(
      (resolve, reject) => {
        const payload =
          options.body === undefined
            ? undefined
            : typeof options.body === 'string'
              ? options.body
              : JSON.stringify(options.body)
        let result:
          | { status: number; headers: Record<string, unknown>; body: unknown; text: string }
          | undefined
        let finished = false
        const complete = () => {
          if (finished && result) resolve(result)
        }
        const req = httpRequest(
          new URL(path, access.urls[0]),
          {
            method: options.method ?? (payload ? 'POST' : 'GET'),
            headers: {
              ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
              ...(payload
                ? {
                    'Content-Type': 'application/json',
                    'Content-Length': String(Buffer.byteLength(payload)),
                  }
                : {}),
              ...options.headers,
            },
          },
          response => {
            const chunks: Buffer[] = []
            response.on('data', chunk => chunks.push(chunk))
            response.on('end', () => {
              const text = Buffer.concat(chunks).toString()
              let body: unknown
              try {
                body = JSON.parse(text)
              } catch {
                body = text
              }
              result = { status: response.statusCode ?? 0, headers: response.headers, body, text }
              complete()
            })
          },
        )
        req.on('error', reject)
        req.once('finish', () => {
          finished = true
          complete()
        })
        req.end(payload)
      },
    )
  return {
    server,
    access,
    request,
    prepared,
    metadata: () => buildMockMetadata({ accountId: 'default', policy }),
    changePolicy() {
      policy = structuredClone(policy)
      policy.revision++
      policy.rules[0].conditions[0].value = 16
    },
    holdMetadata(wait: Promise<void>) {
      metadataWait = wait
    },
  }
}

test('a separate RAM token protects every worker action while public docs reveal no credentials', async t => {
  const f = await fixture(t)
  const token = f.access.token
  assert.ok(token && token.length >= 32)
  assert.ok(f.access.urls.every(url => !url.includes(token)))
  assert.equal((await f.request('/mock/metadata')).status, 401)
  assert.equal((await f.request('/mock/status', { token: 'DIRECTOR-KEY' })).status, 401)
  const docs = await f.request('/mock/openapi.json')
  assert.equal(docs.status, 200)
  const document = docs.body as ReturnType<typeof mockApiOpenApi>
  assert.equal(document.openapi, '3.1.0')
  assert.equal(document.components.schemas.MockBatch.additionalProperties, false)
  assert.deepEqual(Object.keys(document.paths).sort(), [
    '/mock/batches',
    '/mock/metadata',
    '/mock/openapi.json',
    '/mock/overview',
    '/mock/status',
  ])
  const overview = await f.request('/mock/overview')
  const status = await f.request('/mock/status', { token: f.access.token })
  assert.equal(status.status, 200)
  assert.doesNotMatch(
    docs.text + overview.text + status.text,
    new RegExp(`${f.access.token}|PRIVATE-STATUS-KEY`),
  )
  assert.equal(f.prepared.length, 0)
})

test('worker upload prepares only the matching account and current metadata revision', async t => {
  const f = await fixture(t)
  const metadata = await f.request('/mock/metadata', { token: f.access.token })
  const batch = (metadata.body as { data: MockMetadata }).data.example
  const upload = (body: unknown) => f.request('/mock/batches', { token: f.access.token, body })
  assert.equal((await upload({ ...batch, accountId: 'other' })).status, 403)
  f.changePolicy()
  assert.equal((await upload(batch)).status, 409)
  assert.equal((await upload({ ...f.metadata().example, start: true })).status, 400)
  assert.equal((await upload(f.metadata().example)).status, 201)
  assert.equal(f.prepared.length, 1)
  for (const path of ['/mock/start', '/mock/stop', '/mock/send', '/assistant/command'])
    assert.equal((await f.request(path, { token: f.access.token, body: {} })).status, 404)
  assert.equal(f.prepared.length, 1)
})

test('enabling the worker API permits metadata export and preparation before Mock playback is selected', async t => {
  const f = await fixture(t, false)
  const metadata = await f.request('/mock/metadata', { token: f.access.token })
  assert.equal(metadata.status, 200)
  assert.equal(
    (await f.request('/mock/batches', { token: f.access.token, body: f.metadata().example }))
      .status,
    201,
  )
  assert.equal(f.prepared.length, 1)
})

test('cross-origin, forged Host, wrong content types and oversized requests cannot reach prepare', async t => {
  const f = await fixture(t)
  const options = { token: f.access.token, body: f.metadata().example }
  for (const headers of [
    { Origin: 'https://evil.example' },
    { Origin: 'null' },
    { Host: 'evil.example' },
  ]) {
    const result = await f.request('/mock/batches', { ...options, headers })
    assert.equal(result.status, 403)
    assert.equal(result.headers['access-control-allow-origin'], undefined)
  }
  assert.equal(
    (await f.request('/mock/batches', { ...options, headers: { 'Content-Type': 'text/plain' } }))
      .status,
    415,
  )
  assert.equal(
    (
      await f.request('/mock/batches', {
        token: f.access.token,
        body: 'x'.repeat(2 * 1024 * 1024 + 1),
      })
    ).status,
    413,
  )
  assert.equal(f.prepared.length, 0)
})

test('closing revokes in-flight uploads and reopening rotates the RAM token', async t => {
  const f = await fixture(t)
  let finish!: () => void
  f.holdMetadata(
    new Promise<void>(resolve => {
      finish = resolve
    }),
  )
  const pending = f
    .request('/mock/batches', { token: f.access.token, body: f.metadata().example })
    .catch(() => undefined)
  await new Promise(resolve => setTimeout(resolve, 20))
  const old = f.access.token
  const closing = f.server.close()
  assert.equal(f.server.status().active, false)
  finish()
  await closing
  await pending
  assert.equal(f.prepared.length, 0)
  const next = await f.server.start()
  assert.notEqual(next.token, old)
  const result = await fetch(`${next.urls[0]}/mock/status`, {
    headers: { Authorization: `Bearer ${old}` },
  })
  assert.equal(result.status, 401)
})
