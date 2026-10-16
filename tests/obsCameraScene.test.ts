import assert from 'node:assert/strict'
import test from 'node:test'
import { ObsCameraSwitcher } from '../electron/main/services/ObsCameraSwitcher'
import { defaultObsCameraConfig, validateObsCameraConfig } from '../shared/obsCamera'
import type { ObsRpcClient } from '../electron/main/services/ObsWebSocketClient'

const config = {
  ...defaultObsCameraConfig,
  switchMode: 'scene' as const,
  androidSceneName: '小米4K机位',
  iphoneSceneName: 'iPhone机位',
  transitionMethod: 'cut' as const,
}
function fixture(options: { refuse?: boolean; missing?: boolean } = {}) {
  let current = 'iPhone机位'
  const calls: { type: string; data?: Record<string, unknown> }[] = []
  const client: ObsRpcClient = {
    async connect() {},
    async disconnect() {},
    async call(type, data) {
      calls.push({ type, data })
      if (type === 'GetSceneList')
        return {
          scenes: (options.missing ? ['iPhone机位'] : ['小米4K机位', 'iPhone机位', '其他场景']).map(
            sceneName => ({ sceneName }),
          ),
        }
      if (type === 'GetCurrentProgramScene') return { currentProgramSceneName: current }
      if (type === 'SetCurrentProgramScene') {
        if (!options.refuse) current = String(data?.sceneName)
        return {}
      }
      throw new Error(`unexpected OBS request: ${type}`)
    },
  }
  return {
    client,
    calls,
    setCurrent(value: string) {
      current = value
    },
  }
}

test('scene mode reads actual program and switches existing scenes without editing sources', async () => {
  const { client, calls } = fixture()
  const service = new ObsCameraSwitcher(
    { url: 'ws://127.0.0.1:4455', password: '' },
    config,
    client,
  )
  assert.deepEqual(await service.status(true), {
    ok: true,
    selected: 'iphone',
    onProgram: true,
    programScene: 'iPhone机位',
  })
  const after = await service.switchTo('android')
  assert.equal(after.selected, 'android')
  assert.equal(after.programScene, '小米4K机位')
  assert.deepEqual(
    calls.filter(x => x.type.startsWith('Set')),
    [{ type: 'SetCurrentProgramScene', data: { sceneName: '小米4K机位' } }],
  )
  await service.switchTo('android')
  assert.equal(calls.filter(x => x.type.startsWith('Set')).length, 1)
  await service.stop()
})

test('scene mode reports other program scenes as neither camera rather than claiming selected', async () => {
  const f = fixture()
  f.setCurrent('其他场景')
  const service = new ObsCameraSwitcher(
    { url: 'ws://127.0.0.1:4455', password: '' },
    config,
    f.client,
  )
  assert.deepEqual(await service.status(true), {
    ok: true,
    selected: 'none',
    onProgram: false,
    programScene: '其他场景',
  })
  await service.stop()
})

test('missing scene and unacknowledged program change never report a successful switch', async () => {
  for (const options of [{ missing: true }, { refuse: true }]) {
    const f = fixture(options)
    const service = new ObsCameraSwitcher(
      { url: 'ws://127.0.0.1:4455', password: '' },
      config,
      f.client,
    )
    await assert.rejects(service.switchTo('android'))
    if (options.missing)
      assert.equal(
        f.calls.some(x => x.type.startsWith('Set')),
        false,
      )
    const status = await service.status(true)
    assert.notEqual(status.selected, 'android')
    await service.stop()
  }
})

test('scene configuration validates mode and two distinct nonempty scene names', () => {
  validateObsCameraConfig(config)
  validateObsCameraConfig(defaultObsCameraConfig)
  for (const bad of [
    { ...config, switchMode: 'arbitrary' },
    { ...config, androidSceneName: '' },
    { ...config, iphoneSceneName: config.androidSceneName },
  ])
    assert.throws(() => validateObsCameraConfig(bad as typeof config))
})

test('legacy source visibility mode still switches only the configured source items', async () => {
  const items = [
    { sourceName: defaultObsCameraConfig.androidSource, sceneItemId: 1, sceneItemEnabled: true },
    { sourceName: defaultObsCameraConfig.iphoneSource, sceneItemId: 2, sceneItemEnabled: false },
  ]
  const writes: Record<string, unknown>[] = []
  const client: ObsRpcClient = {
    async connect() {},
    async disconnect() {},
    async call(type, data) {
      if (type === 'GetSceneItemList') return { sceneItems: structuredClone(items) }
      if (type === 'GetCurrentProgramScene')
        return { currentProgramSceneName: defaultObsCameraConfig.sceneName }
      if (type === 'SetSceneItemEnabled') {
        writes.push(data!)
        items.find(x => x.sceneItemId === data!.sceneItemId)!.sceneItemEnabled =
          data!.sceneItemEnabled === true
        return {}
      }
      throw new Error(`unexpected ${type}`)
    },
  }
  const service = new ObsCameraSwitcher(
    { url: 'ws://127.0.0.1:4455', password: '' },
    { ...defaultObsCameraConfig, transitionMethod: 'cut' },
    client,
  )
  assert.equal((await service.switchTo('iphone')).selected, 'iphone')
  assert.deepEqual(
    writes.map(x => [x.sceneItemId, x.sceneItemEnabled]),
    [
      [2, true],
      [1, false],
    ],
  )
  await service.stop()
})

test('scene changes are serialized and shutdown rejects further switches', async () => {
  const f = fixture()
  const service = new ObsCameraSwitcher(
    { url: 'ws://127.0.0.1:4455', password: '' },
    config,
    f.client,
  )
  const [first, second] = await Promise.all([
    service.switchTo('android'),
    service.switchTo('iphone'),
  ])
  assert.equal(first.selected, 'android')
  assert.equal(second.selected, 'iphone')
  assert.deepEqual(
    f.calls.filter(x => x.type === 'SetCurrentProgramScene').map(x => x.data?.sceneName),
    ['小米4K机位', 'iPhone机位'],
  )
  await service.stop()
  await assert.rejects(service.switchTo('android'), /已停止/)
})
