import assert from 'node:assert/strict'
import test from 'node:test'
import { xiaomiPreviewFocusPoint } from '../shared/xiaomiCamera'

test('focus coordinates use the displayed upright image and exclude letterboxing', () => {
  const image = {
    left: 100,
    top: 50,
    width: 400,
    height: 400,
    naturalWidth: 360,
    naturalHeight: 640,
  }
  assert.deepEqual(xiaomiPreviewFocusPoint({ x: 300, y: 250 }, image), { x: 0.5, y: 0.5 })
  assert.deepEqual(xiaomiPreviewFocusPoint({ x: 187.5, y: 50 }, image), { x: 0, y: 0 })
  assert.deepEqual(xiaomiPreviewFocusPoint({ x: 412.5, y: 450 }, image), { x: 1, y: 1 })
  assert.equal(xiaomiPreviewFocusPoint({ x: 150, y: 250 }, image), null)
  assert.equal(xiaomiPreviewFocusPoint({ x: 450, y: 250 }, image), null)
  assert.equal(xiaomiPreviewFocusPoint({ x: 300, y: 250 }, { ...image, naturalWidth: 0 }), null)
})
