import assert from 'node:assert/strict'
import test from 'node:test'
import { validateDeskHttp, validateDeskTool } from '../shared/assistantDeskContract.mjs'

test('the existing marker API accepts a recording run and chapter title without a capture session', () => {
  const command = {
    action: 'segment-toggle',
    params: { accountId: 'default', runId: 'recording-run', requestId: 'one-point', label: '补货' },
  }
  assert.deepEqual(validateDeskHttp('/assistant/command', command), command)
  assert.deepEqual(validateDeskTool('assistant_segment_toggle', command.params).command, command)
})

test('stale range-marker clients cannot create a video chapter under old capture guards', () => {
  assert.throws(
    () =>
      validateDeskTool('assistant_segment_toggle', {
        accountId: 'default',
        requestId: 'stale-range',
        sessionId: 'capture-session',
        expectedOpenSegmentId: null,
      }),
    /录像章节|片段起止/,
  )
})

test('chapter labels and run identifiers retain bounded strict public schemas', () => {
  for (const params of [
    { accountId: 'default', label: 'x'.repeat(101) },
    { accountId: 'default', runId: 'bad run' },
    { accountId: 'default', target: 'iphone' },
  ])
    assert.throws(() => validateDeskTool('assistant_segment_toggle', params))
})
