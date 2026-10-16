import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { XiaomiPreviewOwners } from '../electron/main/ipc/XiaomiPreviewOwners'

class Owner extends EventEmitter {
  private destroyed = false
  constructor(readonly id: number) {
    super()
  }
  isDestroyed() {
    return this.destroyed
  }
  destroy() {
    this.destroyed = true
    this.emit('destroyed')
  }
}

test('replacing or cancelling one window preview leaves every other window request running', async () => {
  const owners = new XiaomiPreviewOwners()
  const first = new Owner(1)
  const second = new Owner(2)
  const signals: AbortSignal[] = []
  const finish: Array<() => void> = []
  const preview = (owner: Owner) =>
    owners.run(owner, signal => {
      signals.push(signal)
      return new Promise<void>(resolve => {
        finish.push(resolve)
      })
    })
  const old = preview(first)
  const other = preview(second)
  const latest = preview(first)
  assert.equal(signals[0].aborted, true)
  assert.equal(signals[1].aborted, false)
  assert.equal(signals[2].aborted, false)
  finish[0]()
  await old
  owners.cancel(first.id)
  assert.equal(signals[2].aborted, true)
  assert.equal(signals[1].aborted, false)
  finish[1]()
  finish[2]()
  await Promise.all([other, latest])
  first.destroy()
  second.destroy()
})

test('many sequential frames retain one destruction listener and destruction cancels only its current frame', async () => {
  const owners = new XiaomiPreviewOwners()
  const owner = new Owner(7)
  for (let frame = 0; frame < 200; frame++) await owners.run(owner, async () => undefined)
  assert.equal(owner.listenerCount('destroyed'), 1)
  let current!: AbortSignal
  let finish!: () => void
  const pending = owners.run(owner, signal => {
    current = signal
    return new Promise<void>(resolve => {
      finish = resolve
    })
  })
  owner.destroy()
  assert.equal(current.aborted, true)
  assert.equal(owner.listenerCount('destroyed'), 0)
  finish()
  await pending
  await owners.run(owner, async signal => {
    assert.equal(signal.aborted, true)
  })
  assert.equal(owner.listenerCount('destroyed'), 0)
})
