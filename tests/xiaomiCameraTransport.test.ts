import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
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
  const calls = { large: 0, timeout: 0 }
  const server = http.createServer((request, response) => {
    if (request.url === '/large') { calls.large++; response.end(Buffer.alloc(1024)) }
    else calls.timeout++
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
  assert.equal(calls.large, 1)
  // The total deadline includes connecting: under concurrent browser-test load,
  // it may expire before the timeout fixture receives its first request.
  assert.ok(calls.timeout <= 1, 'A timed-out read must never be retried')
})

test('aborting a preview closes its own HTTP connection and removes its abort listener', async t => {
  let arrived!: () => void
  let otherArrived!: () => void
  let closed!: () => void
  let otherResponse!: http.ServerResponse
  const arrival = new Promise<void>(resolve => {
    arrived = resolve
  })
  const closure = new Promise<void>(resolve => {
    closed = resolve
  })
  const otherArrival = new Promise<void>(resolve => {
    otherArrived = resolve
  })
  const server = http.createServer((request, response) => {
    if (request.url === '/preview') {
      request.on('close', closed)
      arrived()
    } else {
      otherResponse = response
      otherArrived()
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const port = (server.address() as AddressInfo).port
  const controller = new AbortController()
  const input = {
    url: `http://127.0.0.1:${port}/preview`,
    method: 'GET' as const,
    headers: {},
    timeoutMs: 1000,
    maxBytes: 100,
    signal: controller.signal,
  }
  const pending = xiaomiCameraHttpTransport(input)
  const rejected = assert.rejects(pending, { code: 'ABORT_ERR' })
  await arrival
  const otherPending = xiaomiCameraHttpTransport({
    ...input,
    url: `http://127.0.0.1:${port}/other`,
    signal: undefined,
  })
  await otherArrival
  controller.abort()
  await rejected
  await closure
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  otherResponse.end('another client remains available')
  const other = await otherPending
  assert.equal(Buffer.from(other.body).toString(), 'another client remains available')
})

test('completed and pre-aborted preview requests leave no abort listener or extra connection', async t => {
  let calls = 0
  const server = http.createServer((_request, response) => {
    calls++
    response.end('jpeg')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const port = (server.address() as AddressInfo).port
  const controller = new AbortController()
  const input = {
    url: `http://127.0.0.1:${port}/preview`,
    method: 'GET' as const,
    headers: {},
    timeoutMs: 1000,
    maxBytes: 100,
    signal: controller.signal,
  }
  await xiaomiCameraHttpTransport(input)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  controller.abort()
  await assert.rejects(xiaomiCameraHttpTransport(input), { code: 'ABORT_ERR' })
  assert.equal(calls, 1)
})
