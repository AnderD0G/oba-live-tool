import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { XiaomiCameraFileConfig } from '../electron/main/services/XiaomiCameraConfig'
import { XiaomiCameraService } from '../electron/main/services/XiaomiCameraService'

test('camera configuration uses atomic private files and never returns its token to the renderer', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oba-xiaomi-config-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'private', 'xiaomi-camera.json')
  const store = new XiaomiCameraFileConfig(file)
  assert.deepEqual(store.load(), { baseUrl: 'http://192.168.1.5:18765', token: '' })
  const service = new XiaomiCameraService({ store })
  const saved = await service.execute({
    action: 'config-save',
    config: { baseUrl: 'http://192.168.1.5:18765', token: 'fixture-private-key' },
  })
  assert.equal(saved.ok, true)
  const read = await service.execute({ action: 'config-get' })
  assert.equal(read.config?.hasToken, true)
  assert.doesNotMatch(JSON.stringify([read, saved]), /fixture-private-key/)
  assert.equal(new XiaomiCameraFileConfig(file).load().token, 'fixture-private-key')
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const keep = await service.execute({
    action: 'config-save',
    config: { baseUrl: 'http://192.168.1.6:18765' },
  })
  assert.equal(keep.config?.hasToken, true)
  assert.equal(store.load().token, 'fixture-private-key')
})

test('unsafe config permissions or symlinks fail closed without exposing file contents', t => {
  if (process.platform === 'win32') {
    t.skip('POSIX file mode and symlink fixture')
    return
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oba-xiaomi-config-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'config.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      baseUrl: 'http://192.168.1.5:18765',
      token: 'secret-inside-file',
    }),
    { mode: 0o644 },
  )
  const store = new XiaomiCameraFileConfig(file)
  assert.throws(
    () => store.load(),
    error => error instanceof Error && !error.message.includes('secret-inside-file'),
  )
  fs.chmodSync(file, 0o600)
  fs.symlinkSync(file, path.join(directory, 'link.json'))
  assert.throws(() => new XiaomiCameraFileConfig(path.join(directory, 'link.json')).load())
})
