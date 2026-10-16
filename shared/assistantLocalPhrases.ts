// Authored, concise whole-message meanings. These are lexical matches, not
// language-detector confidence, audience location evidence or substring rules.
const phrases: Readonly<Record<string, string>> = Object.freeze({
  hi: '你好',
  hello: '你好',
  nice: '不错',
  thanks: '谢谢',
  'thank you': '谢谢',
  thx: '谢谢',
  ty: '谢谢',
  price: '价格',
  'how much': '多少钱？',
  what: '什么',
  why: '为什么',
  where: '哪里',
  when: '什么时候',
  who: '谁',
  how: '怎么',
  'what game': '什么游戏？',
  btw: '顺便说一下',
  idk: '我不知道',
  lol: '笑出声',
  'can lah': '可以啦！',
  'can meh': '真的可以吗？',
  shiok: '爽；很满意。',
  'bo jio': '没叫上我。',
  'how much ah': '多少钱呀？',
  'this one got stock': '这个有库存吗？',
  'got discount anot': '有没有折扣？',
})

/** Normalize case/whitespace/terminal sentence punctuation; match the entire text. */
export function lookupAssistantLocalPhrase(text: string): { chinese: string; language?: string } | undefined {
  const key = text.trim().toLowerCase().replace(/\s+/gu, ' ').replace(/[.!?。！？]+$/u, '').trim()
  return Object.hasOwn(phrases, key) ? { chinese: phrases[key] } : undefined
}
