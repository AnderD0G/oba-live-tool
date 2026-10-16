import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { EffectGroupStore } from '../electron/main/services/effectGroups/EffectGroupStore'
import { MockEffectsBridge } from '../electron/main/services/mockAssistant/MockEffectsBridge'
import { ObsWebSocketClient } from '../electron/main/services/ObsWebSocketClient'
import { defaultAudiencePolicy, evaluateAudiencePolicy } from '../shared/assistantAudiencePolicy'
import type { AssistantDeskRow } from '../shared/assistantDesk'
import { normalizeEffectGroupsConfig } from '../shared/effectGroups'
import type { HookAction } from '../shared/hooks'
import { defaultObsEnterEffectSettings } from '../shared/obsEffect'

type Data = Record<string, unknown>
function fixture(t: TestContext, actions: HookAction[], groups = false) {
  const input = {
    inputName: 'caption',
    inputUuid: 'original-uuid',
    inputKind: 'text_ft2_source_v2',
    inputSettings: { text: 'Original caption', font: { face: 'Arial', size: 24 }, color: 12 },
  }
  const calls: { type: string; data: Data }[] = []
  let readGate: (() => Promise<void>) | undefined
  let writeGate: (() => Promise<void>) | undefined
  t.mock.method(ObsWebSocketClient.prototype, 'connect', async () => {})
  t.mock.method(ObsWebSocketClient.prototype, 'disconnect', async () => {})
  t.mock.method(ObsWebSocketClient.prototype, 'call', async (type: string, data: Data = {}) => {
    calls.push({ type, data: structuredClone(data) })
    if (type === 'GetInputList')
      return {
        inputs: [
          { inputName: input.inputName, inputUuid: input.inputUuid, inputKind: input.inputKind },
        ],
      }
    if (type === 'GetInputSettings') {
      if (readGate) await readGate()
      assert.ok(data.inputUuid === input.inputUuid || data.inputName === input.inputName)
      return structuredClone(input)
    }
    if (type === 'SetInputSettings') {
      assert.ok(data.inputUuid === input.inputUuid || data.inputName === input.inputName)
      assert.equal(data.overlay, true)
      Object.assign(input.inputSettings, data.inputSettings)
      if (writeGate) await writeGate()
      return {}
    }
    if (type === 'GetSceneItemId') return { sceneItemId: 9 }
    if (type === 'SetSceneItemEnabled' || type === 'CallVendorRequest') return {}
    throw new Error(`Unexpected fake OBS request: ${type}`)
  })
  const policy = defaultAudiencePolicy()
  const config = normalizeEffectGroupsConfig(
    groups
      ? {
          enabled: true,
          targetSceneName: 'Scene',
          groups: [
            {
              audienceRuleId: '$fallback',
              actionKind: 'enter',
              enabled: true,
              slot: 'main-stage',
              concurrency: 'serialize',
              priority: 1,
              durationMs: 1000,
              animations: [
                { assetId: 'pearl', placement: 'center', shortAssetEnd: 'hold-last-frame' },
              ],
              caption: { template: '{{viewer.displayName}}', style: 'brief' },
              coalesce: 'none',
            },
          ],
        }
      : {},
    'account',
  )
  const bridge = new MockEffectsBridge({
    accountId: 'account',
    hooks: {
      webhookPort: 17890,
      migratedObsEffects: true,
      rules: [
        {
          id: 'hook',
          name: 'hook',
          source: 'tiktok',
          eventType: 'viewer.enter',
          enabled: true,
          conditions: [],
          actions,
        },
      ],
    },
    obs: { ...defaultObsEnterEffectSettings },
    groupSnapshot: { config, resources: [], installId: 'mock-owner' },
    policy: async () => policy,
    overlayBaseUrl: () => 'http://127.0.0.1:17892/',
  })
  const row: AssistantDeskRow = {
    id: 'row',
    accountId: 'account',
    sessionId: 'mock-session',
    platform: 'tiktok',
    receivedAt: Date.now(),
    nickname: 'Mock name',
    userId: 'mock-user',
    kind: 'enter',
    original: '',
    translation: { status: 'skipped' },
    reply: { status: 'none' },
  }
  row.triage = evaluateAudiencePolicy(policy, { row })
  const dispatch = () =>
    bridge.dispatch(
      {
        msg_type: 'tiktok_member',
        msg_id: 'event',
        user_id: 'mock-user',
        nick_name: 'Mock name',
        unique_id: 'mock-user',
        content: '',
        time: row.receivedAt,
      } as LiveMessage,
      row,
      true,
    )
  t.after(() => bridge.close())
  return {
    input,
    calls,
    bridge,
    dispatch,
    pauseRead: (work: () => Promise<void>) => {
      readGate = work
    },
    pauseWrite: (work: () => Promise<void>) => {
      writeGate = work
    },
  }
}
const textAction: HookAction = {
  id: 'text',
  type: 'obs.set-text',
  inputName: 'caption',
  template: '{{user.name}}',
}

test('concurrent actions keep the first original snapshot through multiple completed writes', async t => {
  const f = fixture(t, [textAction, { ...textAction, id: 'second', template: 'Second Mock name' }])
  await f.dispatch()
  assert.equal(f.input.inputSettings.text, 'Second Mock name')
  await f.bridge.close()
  assert.equal(f.input.inputSettings.text, 'Original caption')
})

test('Mock legacy text and deprecated show-source text restore only their original text on close', async t => {
  for (const action of [
    textAction,
    {
      id: 'show',
      type: 'obs.show-source',
      target: { sceneName: 'Scene', sourceName: 'image', durationMs: 1000 },
      text: { inputName: 'caption', template: '{{user.name}}' },
    } satisfies HookAction,
  ]) {
    await t.test(action.type, async t => {
      const f = fixture(t, [action])
      await f.dispatch()
      assert.equal(f.input.inputSettings.text, 'Mock name')
      f.input.inputSettings.color = 99
      await f.bridge.close()
      assert.equal(f.input.inputSettings.text, 'Original caption')
      assert.equal(f.input.inputSettings.color, 99)
      assert.deepEqual(f.input.inputSettings.font, { face: 'Arial', size: 24 })
      assert.ok(
        f.calls
          .filter(call => call.type === 'SetInputSettings')
          .every(call => Object.keys(call.data.inputSettings as Data).join() === 'text'),
      )
      assert.equal(
        f.calls.some(call => call.type === 'SetPersistentData'),
        false,
      )
    })
  }
})

test('parallel text actions share the pre-Mock snapshot and close drains an admitted write before restoration', async t => {
  const f = fixture(t, [textAction, { ...textAction, id: 'second', template: 'Second Mock name' }])
  let release!: () => void
  let entered!: () => void
  const writing = new Promise<void>(resolve => {
    entered = resolve
  })
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let first = true
  f.pauseWrite(async () => {
    if (first) {
      first = false
      entered()
      await gate
    }
  })
  const dispatch = f.dispatch()
  await writing
  const closing = f.bridge.close()
  release()
  await Promise.all([dispatch, closing])
  assert.equal(f.input.inputSettings.text, 'Original caption')
  const writes = f.calls.filter(call => call.type === 'SetInputSettings')
  const last = writes.at(-1)
  assert.ok(last)
  assert.equal((last.data.inputSettings as Data).text, 'Original caption')
  assert.equal(
    writes.filter(call => (call.data.inputSettings as Data).text === 'Second Mock name').length,
    0,
  )
})

test('stop during the first snapshot prevents the late write and needs no restoration', async t => {
  const f = fixture(t, [textAction])
  let release!: () => void
  let entered!: () => void
  const reading = new Promise<void>(resolve => {
    entered = resolve
  })
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  f.pauseRead(async () => {
    entered()
    await gate
  })
  const dispatch = f.dispatch()
  await Promise.race([reading, dispatch])
  const closing = f.bridge.close()
  release()
  await Promise.all([dispatch, closing])
  assert.equal(f.input.inputSettings.text, 'Original caption')
  assert.equal(f.calls.filter(call => call.type === 'SetInputSettings').length, 0)
})

test('restoration preserves a human edit and never writes to a replaced same-name input', async t => {
  for (const change of ['text', 'uuid'] as const) {
    await t.test(change, async t => {
      const f = fixture(t, [textAction])
      await f.dispatch()
      if (change === 'text') f.input.inputSettings.text = 'Human edit'
      else f.input.inputUuid = 'replacement-uuid'
      const writes = f.calls.filter(call => call.type === 'SetInputSettings').length
      await f.bridge.close()
      assert.equal(f.calls.filter(call => call.type === 'SetInputSettings').length, writes)
      assert.equal(f.input.inputSettings.text, change === 'text' ? 'Human edit' : 'Mock name')
    })
  }
})

test('Mock effect run receipts remain in the private RAM ledger', async t => {
  const files: string[] = []
  const original = EffectGroupStore.prototype.appendRunEvent
  t.mock.method(
    EffectGroupStore.prototype,
    'appendRunEvent',
    function (this: EffectGroupStore, ...args: Parameters<typeof original>) {
      files.push(this.file)
      return original.apply(this, args)
    },
  )
  const f = fixture(t, [textAction], true)
  await f.dispatch()
  await f.bridge.close()
  assert.ok(files.length > 0)
  assert.deepEqual([...new Set(files)], [':memory:'])
})
