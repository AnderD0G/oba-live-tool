import assert from 'node:assert/strict'
import test from 'node:test'
import { HookEngine } from '../electron/main/services/HookEngine'
import type { ObsEnterEffectService } from '../electron/main/services/ObsEnterEffectService'
import type { HookEvent, HookSettings } from '../shared/hooks'

const event: HookEvent = {
  id: 'mock',
  source: 'tiktok',
  type: 'viewer.enter',
  occurredAt: 1,
  data: { user: { id: 'mock', name: 'mock' } },
}
test('stopping a mock hook cancels a pending delay and prevents dependent OBS writes', async () => {
  let writes = 0
  const settings: HookSettings = {
    webhookPort: 17890,
    migratedObsEffects: true,
    rules: [
      {
        id: 'test',
        name: 'test',
        source: 'tiktok',
        eventType: 'viewer.enter',
        enabled: true,
        conditions: [],
        actions: [
          { id: 'wait', type: 'delay', durationMs: 100 },
          {
            id: 'text',
            type: 'obs.set-text',
            inputName: 'caption',
            template: 'mock',
            dependsOn: ['wait'],
          },
        ],
      },
    ],
  }
  const engine = new HookEngine(
    settings,
    {
      setText: async () => {
        writes++
      },
    } as unknown as ObsEnterEffectService,
    { info() {}, error() {} },
  )
  const controller = new AbortController()
  const work = engine.dispatch(event, { localEffectsOnly: true, signal: controller.signal })
  controller.abort()
  await work
  assert.equal(writes, 0)
})

test('a replaced mock run cannot execute an OBS action even without an aborted delay', async () => {
  let writes = 0
  const engine = new HookEngine(
    {
      webhookPort: 17890,
      migratedObsEffects: true,
      rules: [
        {
          id: 'test',
          name: 'test',
          source: 'tiktok',
          eventType: 'viewer.enter',
          enabled: true,
          conditions: [],
          actions: [{ id: 'text', type: 'obs.set-text', inputName: 'caption', template: 'mock' }],
        },
      ],
    },
    {
      setText: async () => {
        writes++
      },
    } as unknown as ObsEnterEffectService,
    { info() {}, error() {} },
  )
  await engine.dispatch(event, { localEffectsOnly: true, current: () => false })
  assert.equal(writes, 0)
})
