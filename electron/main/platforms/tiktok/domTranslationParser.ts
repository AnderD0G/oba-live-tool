export interface TikTokDomTranslationRow {
  fingerprint: string
  original: string
  nickname: string
  chinese?: string
}

export interface TikTokDomTranslationSnapshot {
  rows: TikTokDomTranslationRow[]
  overflow: boolean
}

/** Self-contained factory: its source runs in the page without imported helpers or globals. */
export function createTikTokDomTranslationParser() {
  const MAX_ORIGINAL_LENGTH = 8000
  const MAX_ROWS = 64
  const TARGET_WRAPPER = '.immersive-translate-target-wrapper'
  const TARGET_INNER = '.immersive-translate-target-inner'
  const CHINESE_LANGS = ['zh-CN', 'zh-Hans']
  const parser = {
    excluded(element: Element) {
      return !!element.closest(
        'input, textarea, select, option, [contenteditable], script, style, template, noscript',
      )
    },
    hidden(element: Element) {
      let parent: Element | null = element
      for (let depth = 0; parent && depth < 32; depth++, parent = parent.parentElement) {
        const style = window.getComputedStyle(parent)
        if (style.display === 'none' || style.visibility === 'hidden' ||
          style.visibility === 'collapse' || style.opacity === '0') return true
      }
      return parent !== null
    },
    /** Reject oversized trees rather than clipping text into an apparent exact match. */
    readText(item: Node, depth: number, budget: { nodes: number; length: number; overflow: boolean }, includeTranslation: boolean): string {
        if (++budget.nodes > 512 || depth > 32) { budget.overflow = true; return '' }
        let text = ''
        if (item.nodeType === Node.TEXT_NODE) text = item.nodeValue || ''
        else if (item instanceof Element && !parser.excluded(item) && !parser.hidden(item)) {
          if (!includeTranslation && item.matches(TARGET_WRAPPER)) return ''
          if (item.tagName === 'BR') text = '\n'
          else if (item.tagName === 'IMG') text = item.getAttribute('alt') || ''
          else {
            let value = ''
            for (const child of item.childNodes) { value += parser.readText(child, depth + 1, budget, includeTranslation); if (budget.overflow) break }
            return value
          }
        }
        budget.length += text.length
        if (budget.length > MAX_ORIGINAL_LENGTH) budget.overflow = true
        return text
    },
    originalText(node: Node, includeTranslation = false): string | undefined {
      const budget = { nodes: 0, length: 0, overflow: false }
      const result = parser.readText(node, 0, budget, includeTranslation)
      return budget.overflow ? undefined : result
    },
    /** Read nickname text, dropping translation wrappers so translated names never leak. */
    nicknameText(node: Element): string {
      if (parser.excluded(node) || parser.hidden(node)) return ''
      return (parser.originalText(node) || '').trim()
    },
    /** Exactly one visible Chinese wrapper yields a translation, otherwise undefined. */
    chineseText(content: Element): string | undefined {
      const wrappers = Array.from(content.querySelectorAll(TARGET_WRAPPER)).filter(
        wrapper => !parser.hidden(wrapper),
      )
      if (wrappers.length !== 1) return undefined
      const wrapper = wrappers[0]
      const lang = wrapper.getAttribute('lang') || ''
      if (!CHINESE_LANGS.includes(lang)) return undefined
      const inners = Array.from(wrapper.querySelectorAll(TARGET_INNER)).filter(
        inner => !parser.hidden(inner),
      )
      if (inners.length !== 1) return undefined
      const text = parser.originalText(inners[0], true)?.trim()
      if (!text || text.length > MAX_ORIGINAL_LENGTH) return undefined
      if (!/[\u4e00-\u9fff]/.test(text)) return undefined
      return text
    },
    parseRow(row: Element): TikTokDomTranslationRow | undefined {
      if (parser.excluded(row) || parser.hidden(row)) return undefined
      if (row.getAttribute('data-e2e') !== 'chat-message') return undefined
      const body = row.querySelector(':scope > div:nth-child(2)')
      if (!body) return undefined
      const header = body.querySelector(':scope > div:first-child')
      const owner = header?.querySelector('[data-e2e="message-owner-name"]')
      if (!owner) return undefined
      const content = body.querySelector(':scope > div:nth-child(2)')
      if (!content) return undefined
      const original = parser.originalText(content)
      if (!original?.trim() || original.length > MAX_ORIGINAL_LENGTH) return undefined
      const nickname = (owner.getAttribute('title') || parser.nicknameText(owner)).trim()
      if (!nickname || nickname.length > 200) return undefined
      const chinese = parser.chineseText(content)
      const row_: TikTokDomTranslationRow = {
        fingerprint: JSON.stringify([nickname, original]),
        original,
        nickname,
      }
      if (chinese && chinese !== original) row_.chinese = chinese
      return row_
    },
    snapshot(document: Document): TikTokDomTranslationSnapshot {
      const all = Array.from(document.querySelectorAll('[data-e2e="chat-message"]'))
      const overflow = all.length > MAX_ROWS
      const recent = all.slice(-MAX_ROWS)
      const rows: TikTokDomTranslationRow[] = []
      for (const row of recent) {
        const parsed = parser.parseRow(row)
        if (parsed) rows.push(parsed)
      }
      return { rows, overflow }
    },
  }
  return parser
}

export type TikTokDomTranslationParser = ReturnType<typeof createTikTokDomTranslationParser>
// This private, fixed source is never accepted from an API caller or platform configuration.
export const tikTokDomTranslationParserSource = createTikTokDomTranslationParser.toString()
