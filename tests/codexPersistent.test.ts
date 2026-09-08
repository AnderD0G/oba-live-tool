import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { CodexAppServer } from '../electron/main/services/CodexAppServer'
import { PersistentCodexDraftService } from '../electron/main/services/PersistentCodexDraftService'

const request = { requestId: 'test', comment: '你好', instructions: '简短回复' }
function createFixture() {
  const children: CodexAppServer[] = []
  const service = new PersistentCodexDraftService(undefined, async directory => {
    const child = new CodexAppServer({
      executable: process.execPath,
      args: [path.resolve('tests/fixtures/codex-app-server.cjs')],
      cwd: directory,
      env: process.env,
    })
    children.push(child)
    return child
  })
  return { service, children }
}

test('prewarms once; reuses PID across requests while isolating comment/model and streaming', async () => {
  const { service, children } = createFixture()
  try {
    const [first, second] = await Promise.all([service.status(), service.status()])
    assert.ok(first.available && second.available)
    assert.equal(first.pid, second.pid)
    const chunks: string[] = []
    const a = await service.generate(1, { ...request, model: 'selected-model' }, event => {
      if (event.text) chunks.push(event.text)
    })
    assert.ok(a.ok)
    assert.equal(a.text, '你好，selected-model！')
    assert.deepEqual(chunks, ['你好，', '你好，selected-model！'])
    const b = await service.generate(1, { ...request, requestId: 'next' })
    assert.ok(b.ok)
    assert.equal(b.text, '你好，default！')
    const status = await service.status()
    assert.ok(status.available)
    assert.equal(status.pid, first.pid)
    assert.equal(children.length, 1)
  } finally {
    service.dispose()
  }
  assert.equal(children[0].alive, false)
})

test('only owner can cancel; a cancelled turn leaves the process usable', async () => {
  const { service, children } = createFixture()
  try {
    await service.status()
    const pending = service.generate(1, request, event => {
      if (event.text) {
        assert.equal(service.cancel(2, request.requestId), false)
        assert.equal(service.cancel(1, 'wrong'), false)
        assert.equal(service.cancel(1, request.requestId), true)
      }
    })
    assert.equal((await service.generate(2, { ...request, requestId: 'concurrent' })).ok, false)
    assert.deepEqual(await pending, { ok: false, error: '已取消生成' })
    assert.ok((await service.generate(1, { ...request, requestId: 'retry' })).ok)
    assert.equal(children.length, 1)
  } finally {
    service.dispose()
  }
})

test('recovers after process exit; reports errors without raw server diagnostics', async () => {
  const { service, children } = createFixture()
  try {
    await service.status()
    await assert.rejects(children[0].request('unsupported', {}), error => {
      assert.doesNotMatch(String(error), /private diagnostic/)
      return true
    })
    await assert.rejects(children[0].request('test/crash', {}))
    assert.ok((await service.generate(1, request)).ok)
    assert.equal(children.length, 2)
    assert.notEqual(children[0].pid, children[1].pid)
  } finally {
    service.dispose()
  }
})

test('closing during generation settles pending work and does not restart the server', async () => {
  const { service, children } = createFixture()
  await service.status()
  const result = await service.generate(1, request, event => {
    if (event.text) service.dispose()
  })
  assert.equal(result.ok, false)
  assert.equal((await service.status()).available, false)
  assert.equal(children[0].alive, false)
})
