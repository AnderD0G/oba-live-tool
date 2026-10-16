import chineseNames from './emoji-data/cldr-46-zh.json'

export interface AssistantEmojiAnnotation {
  readonly emoji: string
  readonly count: number
  readonly chineseName: string
  readonly chineseMeaning?: string
  readonly contextNote: string
  readonly source: 'cldr-46' | 'unknown'
}
export const ASSISTANT_EMOJI_LIMIT = 12
export const ASSISTANT_EMOJI_CACHE_LIMIT = 512
export const ASSISTANT_EMOJI_CONTEXT_NOTE =
  '常见解读取决于语境，不能据此确定观众真实意图、身份或居住地。'
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const emojiPattern =
  /\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Presentation}|[#*0-9]\uFE0F?\u20E3/u
const names: Readonly<Record<string, string>> = chineseNames
const empty: readonly AssistantEmojiAnnotation[] = Object.freeze([])
const cache = new Map<string, readonly AssistantEmojiAnnotation[]>()
// Project text, distinct from official CLDR glyph names. These are possible
// common uses, never an assertion of the sender's intent or a rule input.
const commonReadings: Readonly<Record<string, string>> = {
  '❤': '喜爱、支持或感谢',
  '😂': '觉得很好笑、笑出眼泪',
  '🤣': '大笑、笑得停不下来',
  '🙏': '感谢、请求或祈愿',
  '👍': '赞同、认可或支持',
  '👎': '不赞同或不满意',
  '🔥': '精彩、火热或很厉害，也可能指火焰',
  '👏': '鼓掌、赞赏或庆祝',
  '😅': '尴尬、紧张后松口气，或带着笑意解释',
  '😭': '难过、大哭，也常夸张表达感动或笑得厉害',
  '🥰': '喜爱、温暖或感到幸福',
  '😉': '开玩笑、会意或友好暗示',
  '🙃': '反讽、无奈或故作轻松',
  '💀': '夸张表示笑死、震惊，也可能指死亡话题',
  '😊': '友好、开心或感谢',
  '🙂': '微笑、礼貌；某些语境也可能是勉强或反讽',
  '🎉': '庆祝或祝贺',
  '💕': '喜爱、亲近或支持',
  '💔': '伤心、失望或心碎',
  '👀': '关注、好奇或等着看',
  '🤔': '思考、疑问或犹豫',
  '✨': '闪耀、美好或强调亮点',
  '🫶': '喜爱、感谢或支持',
}

export function annotateAssistantEmoji(original: unknown): readonly AssistantEmojiAnnotation[] {
  if (typeof original !== 'string') return empty
  const text = original.slice(0, 8000)
  const existing = cache.get(text)
  if (existing) {
    cache.delete(text)
    cache.set(text, existing)
    return existing
  }
  const found = new Map<
    string,
    {
      emoji: string
      count: number
      chineseName: string
      chineseMeaning?: string
      contextNote: string
      source: AssistantEmojiAnnotation['source']
    }
  >()
  if (emojiPattern.test(text))
    for (const { segment } of segmenter.segment(text)) {
      if (!emojiPattern.test(segment)) continue
      const key = segment.replace(/\uFE0F|\uFE0E/g, '')
      const repeated = found.get(key)
      if (repeated) {
        repeated.count++
        continue
      }
      if (found.size >= ASSISTANT_EMOJI_LIMIT) continue
      const name = names[key]
      const reading = name ? commonReadings[key.replace(/\p{Emoji_Modifier}/gu, '')] : undefined
      found.set(key, {
        emoji: segment,
        count: 1,
        chineseName: name ?? '含义未知',
        ...(reading ? { chineseMeaning: reading } : {}),
        contextNote: ASSISTANT_EMOJI_CONTEXT_NOTE,
        source: name ? 'cldr-46' : 'unknown',
      })
    }
  const annotations = found.size
    ? Object.freeze([...found.values()].map(item => Object.freeze(item)))
    : empty
  cache.set(text, annotations)
  if (cache.size > ASSISTANT_EMOJI_CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  return annotations
}
