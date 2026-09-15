import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeTikTokUsername,
  toTikTokComment,
} from '../electron/main/platforms/tiktok/messages'

test('normalizes TikTok usernames and live URLs', () => {
  assert.equal(normalizeTikTokUsername(' @my_creator '), 'my_creator')
  assert.equal(
    normalizeTikTokUsername('https://www.tiktok.com/@my_creator/live?lang=en'),
    'my_creator',
  )
})

test('maps a TikTok chat event into the shared live-comment shape', () => {
  assert.deepEqual(
    toTikTokComment({
      content: ' 011 ',
      common: { msgId: 'message-1', createTime: '123456' },
      user: { id: 'user-1', displayId: 'buyer_01', nickname: '买家一号' },
    }),
    {
      msg_type: 'tiktok_comment',
      msg_id: 'message-1',
      nick_name: '买家一号',
      user_id: 'user-1',
      unique_id: 'buyer_01',
      content: '011',
      time: 123456,
    },
  )
})

test('ignores empty comments and comments without a user', () => {
  assert.equal(toTikTokComment({ content: ' ', user: { id: '1' } }), null)
  assert.equal(toTikTokComment({ content: 'hello' }), null)
})
