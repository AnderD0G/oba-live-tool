import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { StudioMicHotkey } from '../electron/main/services/StudioMicHotkey'

const helperPath = path.resolve('.cache/native/studio-mic-hotkey')
const state = {
  supported: true,
  running: true,
  accessGranted: true,
  hotkey: 'Control+Option+M',
  micState: 'unknown',
  message: '请在 TikTok LIVE Studio 中确认麦克风状态。',
}
const output = (data: Record<string, unknown> = {}) => ({
  stdout: JSON.stringify({ ok: true, data: { ...state, ...data } }),
})
const forbiddenExec = async () => {
  throw new Error('helper must not run for this command')
}

test('invalid or expanded commands never reach the native helper', async () => {
  const service = new StudioMicHotkey({ platform: 'darwin', helperPath, exec: forbiddenExec })
  for (const command of [
    null,
    [],
    {},
    { action: 'open' },
    { action: 'toggle', hotkey: 'Command+Q' },
    { action: 'status', path: '/tmp/other' },
  ]) {
    const result = await service.execute(command)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, 'STUDIO_MIC_INVALID_COMMAND')
  }
})

test('unsupported hosts report status without starting a Mac helper', async () => {
  const service = new StudioMicHotkey({ platform: 'win32', helperPath, exec: forbiddenExec })
  const status = await service.execute({ action: 'status' })
  assert.equal(status.ok, true)
  if (status.ok)
    assert.deepEqual(
      {
        supported: status.data.supported,
        running: status.data.running,
        accessGranted: status.data.accessGranted,
        micState: status.data.micState,
      },
      { supported: false, running: false, accessGranted: false, micState: 'unknown' },
    )
  const toggle = await service.execute({ action: 'toggle' })
  assert.equal(toggle.ok, false)
  if (!toggle.ok) assert.equal(toggle.error.code, 'STUDIO_MIC_UNSUPPORTED_PLATFORM')
})

test('missing helper configuration reports unavailable without trying another executable', async () => {
  for (const configuredPath of [undefined, 'relative-helper']) {
    const service = new StudioMicHotkey({
      platform: 'darwin',
      helperPath: configuredPath,
      exec: forbiddenExec,
    })
    const result = await service.execute({ action: 'status' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, 'STUDIO_MIC_HELPER_UNAVAILABLE')
  }
})

test('status uses its read-only native command and never claims a microphone state', async () => {
  const service = new StudioMicHotkey({
    platform: 'darwin',
    helperPath,
    exec: async (file, args, options) => {
      assert.equal(file, helperPath)
      assert.deepEqual(args, ['--status'])
      assert.equal(options.timeout, 8000)
      assert.equal(options.maxBuffer, 65536)
      return output({ running: false, accessGranted: false })
    },
  })
  const result = await service.execute({ action: 'status' })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.data.running, false)
    assert.equal(result.data.accessGranted, false)
    assert.equal(result.data.micState, 'unknown')
    assert.notEqual(result.data.sent, true)
  }
})

test('access is requested only by the explicit access action', async () => {
  const service = new StudioMicHotkey({
    platform: 'darwin',
    helperPath,
    exec: async (_file, args) => {
      assert.deepEqual(args, ['--request-access'])
      return output({ accessGranted: false, message: '请在系统设置中允许 OBA 控制键盘事件。' })
    },
  })
  const result = await service.execute({ action: 'request-access' })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.data.accessGranted, false)
})

test('a successful toggle reports delivery but never infers muted or unmuted', async () => {
  const service = new StudioMicHotkey({
    platform: 'darwin',
    helperPath,
    exec: async (_file, args) => {
      assert.deepEqual(args, ['--toggle'])
      return output({ sent: true })
    },
  })
  const result = await service.execute({ action: 'toggle' })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.data.sent, true)
    assert.equal(result.data.hotkey, 'Control+Option+M')
    assert.equal(result.data.micState, 'unknown')
  }
})

test('simultaneous and rapid toggles are rejected before a second key can be sent', async () => {
  let finish!: (value: { stdout: string }) => void
  let currentTime = 1000
  let executions = 0
  const service = new StudioMicHotkey({
    platform: 'darwin',
    helperPath,
    now: () => currentTime,
    exec: async () => {
      executions++
      return new Promise(resolve => {
        finish = resolve
      })
    },
  })
  const first = service.execute({ action: 'toggle' })
  const concurrent = await service.execute({ action: 'toggle' })
  assert.equal(concurrent.ok, false)
  if (!concurrent.ok) assert.equal(concurrent.error.code, 'STUDIO_MIC_BUSY')
  finish(output({ sent: true }))
  assert.equal((await first).ok, true)
  currentTime = 2199
  const rapid = await service.execute({ action: 'toggle' })
  assert.equal(rapid.ok, false)
  if (!rapid.ok) assert.equal(rapid.error.code, 'STUDIO_MIC_COOLDOWN')
  assert.equal(executions, 1)
  currentTime = 2200
  const later = service.execute({ action: 'toggle' })
  finish(output({ sent: true }))
  assert.equal((await later).ok, true)
  assert.equal(executions, 2)
})

test('native permission, app and focus failures remain failures rather than delivery', async () => {
  for (const code of [
    'STUDIO_MIC_PERMISSION_REQUIRED',
    'STUDIO_MIC_NOT_RUNNING',
    'STUDIO_MIC_FOCUS_FAILED',
  ]) {
    const service = new StudioMicHotkey({
      platform: 'darwin',
      helperPath,
      exec: async () => ({
        stdout: JSON.stringify({
          ok: false,
          error: { code, message: '未发送热键。' },
        }),
      }),
    })
    const result = await service.execute({ action: 'toggle' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, code)
  }
})

test('execution failures distinguish missing helper and timeout without returning child output', async () => {
  for (const [failure, expectedCode] of [
    [{ code: 'ENOENT', stderr: 'private child output' }, 'STUDIO_MIC_HELPER_UNAVAILABLE'],
    [{ code: 'ETIMEDOUT' }, 'STUDIO_MIC_TIMEOUT'],
    [{ killed: true, signal: 'SIGTERM' }, 'STUDIO_MIC_TIMEOUT'],
    [{ code: 2, stderr: 'private child output' }, 'STUDIO_MIC_HELPER_FAILED'],
  ] as const) {
    const service = new StudioMicHotkey({
      platform: 'darwin',
      helperPath,
      exec: async () => {
        throw failure
      },
    })
    const result = await service.execute({ action: 'status' })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.error.code, expectedCode)
      assert.doesNotMatch(result.error.message, /private child output/)
    }
  }
})

test('malformed helper output and unsupported claims never become a successful action', async () => {
  for (const stdout of [
    'not JSON',
    JSON.stringify({ ok: true }),
    output({ micState: 'muted' }).stdout,
    output({ hotkey: 'Command+Q' }).stdout,
    output({ sent: true }).stdout,
  ]) {
    const service = new StudioMicHotkey({
      platform: 'darwin',
      helperPath,
      exec: async () => ({ stdout }),
    })
    const result = await service.execute({ action: 'status' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, 'STUDIO_MIC_INVALID_RESPONSE')
  }
  const service = new StudioMicHotkey({
    platform: 'darwin',
    helperPath,
    exec: async () => output(),
  })
  const result = await service.execute({ action: 'toggle' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'STUDIO_MIC_INVALID_RESPONSE')
})
