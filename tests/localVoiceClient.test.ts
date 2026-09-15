import assert from 'node:assert/strict'
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LocalVoiceClient } from '../electron/main/services/LocalVoiceClient'

async function serverFixture(
  handler: (req: IncomingMessage, res: ServerResponse, body: Record<string, string>) => void,
) {
  const dir = await mkdtemp(join(tmpdir(), 'oba-voice-test-'))
  const tokenFile = join(dir, 'token.txt')
  await writeFile(tokenFile, 'local-test-token')
  const server = createServer(async (req, res) => {
    assert.equal(req.headers['x-voice-token'], 'local-test-token')
    let body = ''
    for await (const chunk of req) body += chunk
    res.setHeader('Content-Type', 'application/json')
    handler(req, res, body ? JSON.parse(body) : {})
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return {
    client: new LocalVoiceClient(async () => tokenFile, `http://127.0.0.1:${address.port}`, 5),
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await unlink(tokenFile)
      await rmdir(dir)
    },
  }
}

test('voice HTTP bridge waits for playback completion rather than treating acceptance as success', async () => {
  let statusCalls = 0
  let posts = 0
  const phases: string[] = []
  const fixture = await serverFixture((req, res, body) => {
    if (req.url === '/v1/speak') {
      posts++
      assert.equal(body.mode, 'broadcast')
      assert.match(body.request_id, /^oba-[0-9a-f]{64}$/)
      res.end(JSON.stringify({ id: 'job-1' }))
    } else {
      statusCalls++
      res.end(
        JSON.stringify({
          jobs: [{ id: 'job-1', status: statusCalls === 1 ? '正在合成' : '声卡播放完成' }],
        }),
      )
    }
  })
  try {
    await fixture.client.speak('a', 'comment-1', '你好', new AbortController().signal, value =>
      phases.push(value),
    )
    assert.equal(posts, 1)
    assert.deepEqual(phases, ['语音台：正在合成', '语音台：声卡播放完成'])
  } finally {
    await fixture.close()
  }
})

test('aborting an uncertain submission sends scoped cancellation with the same request id', async () => {
  let posted!: () => void
  const submitted = new Promise<void>(resolve => {
    posted = resolve
  })
  let submittedId = ''
  let cancelledId = ''
  const fixture = await serverFixture((req, res, body) => {
    if (req.url === '/v1/speak') {
      submittedId = body.request_id
      posted()
      // Deliberately lose the acceptance response.
    } else if (req.url === '/v1/cancel') {
      cancelledId = body.request_id
      res.end('{"ok":true}')
    }
  })
  try {
    const controller = new AbortController()
    const result = fixture.client.speak('a', '1', '你好', controller.signal, () => {})
    await submitted
    controller.abort()
    await assert.rejects(result, /已关闭/)
    assert.equal(cancelledId, submittedId)
  } finally {
    await fixture.close()
  }
})

test('preflight rejects an unarmed voice service and remote hosts are disallowed', async () => {
  assert.throws(() => new LocalVoiceClient(async () => '', 'https://remote.example'), /仅支持本机/)
  const fixture = await serverFixture((_req, res) =>
    res.end(JSON.stringify({ model_status: '就绪', reference_ready: true, armed: false })),
  )
  try {
    const result = await fixture.client.check()
    assert.equal(result.ok, false)
    assert.match(result.message, /开启声卡/)
  } finally {
    await fixture.close()
  }
})
