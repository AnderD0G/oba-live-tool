import assert from 'node:assert/strict'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { xiaomiCameraHttpTransport } from '../electron/main/services/XiaomiCameraService'

test('the native transport never follows redirects or forwards its Bearer token to a second endpoint', async t => {
  let followed = false
  const server = http.createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: '/target' })
      response.end()
    } else {
      followed = true
      response.end('must not be requested')
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const port = (server.address() as AddressInfo).port
  const result = await xiaomiCameraHttpTransport({
    url: `http://127.0.0.1:${port}/redirect`,
    method: 'GET',
    headers: { Authorization: 'Bearer isolated-fixture' },
    timeoutMs: 1000,
    maxBytes: 100,
  })
  assert.equal(result.status, 302)
  assert.equal(followed, false)
})

test('the native transport bounds payloads and has a total timeout without retrying', async t => {
  let calls = 0
  const server = http.createServer((request, response) => {
    calls++
    if (request.url === '/large') response.end(Buffer.alloc(1024))
    // The timeout fixture intentionally leaves the connection unanswered.
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const port = (server.address() as AddressInfo).port
  const request = {
    url: `http://127.0.0.1:${port}/large`,
    method: 'GET' as const,
    headers: {},
    timeoutMs: 1000,
    maxBytes: 16,
  }
  await assert.rejects(xiaomiCameraHttpTransport(request), { code: 'XIAOMI_RESPONSE_TOO_LARGE' })
  await assert.rejects(
    xiaomiCameraHttpTransport({
      ...request,
      url: `http://127.0.0.1:${port}/timeout`,
      timeoutMs: 30,
    }),
    { code: 'ETIMEDOUT' },
  )
  assert.equal(calls, 2)
})
