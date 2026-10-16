import assert from 'node:assert/strict'
import test from 'node:test'
import { LatestXiaomiZoom } from '../src/pages/AssistantDesk/LatestXiaomiZoom'

const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
}
function clock() {
  let now = 1000
  const timers = new Set<{ at: number; run: () => void }>()
  return {
    now: () => now,
    schedule(run: () => void, delayMs: number) {
      const timer = { at: now + delayMs, run }
      timers.add(timer)
      return () => {
        timers.delete(timer)
      }
    },
    advance(ms: number) {
      now += ms
      for (const timer of [...timers])
        if (timer.at <= now) {
          timers.delete(timer)
          timer.run()
        }
    },
  }
}

test('zoom dragging keeps one write in flight and delivers only the final decimal target after it', async () => {
  const time = clock()
  const calls: number[] = []
  let finish!: (ok: boolean) => void
  const queue = new LatestXiaomiZoom({
    ...time,
    submit: ratio => {
      calls.push(ratio)
      return new Promise(resolve => {
        finish = resolve
      })
    },
  })
  queue.request(1.23)
  assert.deepEqual(calls, [1.23])
  queue.request(1.75)
  queue.request(2.38)
  queue.request(2.67)
  assert.deepEqual(calls, [1.23])
  finish(true)
  await settle()
  time.advance(299)
  assert.deepEqual(calls, [1.23])
  time.advance(1)
  assert.deepEqual(calls, [1.23, 2.67])
  finish(true)
  await settle()
  time.advance(1000)
  assert.deepEqual(calls, [1.23, 2.67])
  queue.dispose()
})

test('a failed zoom never replays an uncertain target or a queued write automatically', async () => {
  const time = clock()
  const calls: number[] = []
  let finish!: (ok: boolean) => void
  const queue = new LatestXiaomiZoom({
    ...time,
    submit: ratio => {
      calls.push(ratio)
      return new Promise(resolve => {
        finish = resolve
      })
    },
  })
  queue.request(1.2)
  queue.request(2.45)
  assert.deepEqual(calls, [1.2])
  finish(false)
  await settle()
  time.advance(1000)
  assert.deepEqual(calls, [1.2])
  queue.dispose()
})

test('ending a drag at the in-flight ratio cancels older pending values and unmount drops delayed writes', async () => {
  const time = clock()
  const calls: number[] = []
  let finish!: (ok: boolean) => void
  const queue = new LatestXiaomiZoom({
    ...time,
    submit: ratio => {
      calls.push(ratio)
      return new Promise(resolve => {
        finish = resolve
      })
    },
  })
  queue.request(1.37)
  queue.request(2.51)
  queue.request(1.37)
  finish(true)
  await settle()
  time.advance(300)
  assert.deepEqual(calls, [1.37])
  queue.request(3.17)
  assert.deepEqual(calls, [1.37, 3.17])
  queue.request(4.28)
  finish(true)
  await settle()
  queue.dispose()
  time.advance(300)
  assert.deepEqual(calls, [1.37, 3.17])
})

test('a new idle request can reapply the same ratio after another client changed the camera', async () => {
  const time = clock()
  const calls: number[] = []
  const queue = new LatestXiaomiZoom({
    ...time,
    submit: async ratio => {
      calls.push(ratio)
      return true
    },
  })
  queue.request(1.23)
  await settle()
  time.advance(300)
  queue.request(1.23)
  await settle()
  assert.deepEqual(calls, [1.23, 1.23])
  queue.dispose()
})
