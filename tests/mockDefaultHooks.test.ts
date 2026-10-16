import assert from 'node:assert/strict'
import test from 'node:test'
import { mockHookSettings } from '../electron/main/services/mockAssistant/MockDefaultHooks'
import { defaultHookSettings } from '../shared/hooks'
import { OBS_INSTANT_INPUTS } from '../shared/obsEffect'

test('empty production hooks yield disposable local welcome/like/follow templates with no AI or public send', () => {
  const input = structuredClone(defaultHookSettings)
  const output = mockHookSettings(input)
  assert.equal(input.rules.length, 0)
  assert.deepEqual(
    output.rules.map(rule => rule.eventType),
    ['viewer.enter', 'viewer.like', 'viewer.follow'],
  )
  assert.deepEqual(
    output.rules.map(rule => rule.actions[0].type),
    ['obs.art-text', 'obs.art-text', 'obs.art-text'],
  )
  assert.deepEqual(
    output.rules.map(rule => (rule.actions[0] as { inputName: string }).inputName),
    [...OBS_INSTANT_INPUTS],
  )
  output.rules[0].name = 'changed'
  assert.equal(input.rules.length, 0)
})

test('configured production rules are copied without adding or enabling a fallback', () => {
  const input = mockHookSettings(defaultHookSettings)
  input.rules[0].enabled = false
  const output = mockHookSettings(input)
  assert.deepEqual(output, input)
  assert.notEqual(output, input)
  assert.notEqual(output.rules[0], input.rules[0])
})
