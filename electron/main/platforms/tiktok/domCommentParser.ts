export interface TikTokDomParsedComment {
  content: string
  nickName: string
  userId: ''
  handle: string
}

export type TikTokDomRowResult =
  | { parseStatus: 'parsed'; comment: TikTokDomParsedComment }
  | { parseStatus: 'ignored' | 'enterMessage' | 'noContent' | 'noUser' }

/** Self-contained factory: its source runs in the page without imported helpers or globals. */
export function createTikTokDomParser() {
  const parser = {
    excluded(element: Element) {
      return !!element.closest(
        'input, textarea, select, option, [contenteditable], [data-e2e="room-chat-input-field"], script, style, template, noscript',
      )
    },
    text(node: Node, omitted?: Element): string {
      if (node === omitted) return ''
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || ''
      if (!(node instanceof Element) || parser.excluded(node)) return ''
      const style = window.getComputedStyle(node)
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        style.opacity === '0'
      )
        return ''
      if (node.tagName === 'BR') return '\n'
      if (node.tagName === 'IMG') return node.getAttribute('alt') || ''
      let value = ''
      for (const child of node.childNodes) value += parser.text(child, omitted)
      return value
    },
    parse(row: Element): TikTokDomRowResult {
      if (parser.excluded(row)) return { parseStatus: 'ignored' }
      const kind = row.getAttribute('data-e2e') || ''
      if (kind === 'enter-message') return { parseStatus: 'enterMessage' }
      if (kind && kind !== 'chat-message') return { parseStatus: 'ignored' }
      const body = row.querySelector(':scope > div:nth-child(2)')
      if (!body) return { parseStatus: kind === 'chat-message' ? 'noContent' : 'ignored' }
      const header = body.querySelector(':scope > div:first-child')
      const modernUser = header?.matches('[data-e2e="message-owner-name"]')
        ? header
        : header?.querySelector('[data-e2e="message-owner-name"]')
      const legacyUser = body.querySelector('[data-e2e="comment-username"]')
      const user = kind === 'chat-message' && modernUser ? modernUser : legacyUser
      if (!kind && !legacyUser) return { parseStatus: 'ignored' }
      const modernContent = body.querySelector(':scope > div:nth-child(2)')
      const content =
        kind === 'chat-message' && modernUser
          ? modernContent
            ? parser.text(modernContent).trim()
            : ''
          : legacyUser
            ? parser
                .text(body, legacyUser)
                .split('\n')
                .map(line => line.trim())
                .filter(Boolean)
                .at(-1) || ''
            : modernContent
              ? parser.text(modernContent).trim()
              : ''
      if (!content) return { parseStatus: 'noContent' }
      const nickName = user && !parser.excluded(user) ? parser.text(user).trim() : ''
      if (!nickName) return { parseStatus: 'noUser' }
      // A link in the comment body is a mention, not the author's handle.
      const ownerContext = kind === 'chat-message' && modernUser ? header : body
      const ownerLink = user?.matches('a[href*="/@"]')
        ? user
        : user?.closest('a[href*="/@"]') || user?.querySelector('a[href*="/@"]')
      const href =
        ownerLink && ownerContext?.contains(ownerLink) ? ownerLink.getAttribute('href') || '' : ''
      const handle = href.match(/\/@([^/?#]+)/)?.[1] || ''
      return { parseStatus: 'parsed', comment: { content, nickName, userId: '', handle } }
    },
    fingerprint(comment: TikTokDomParsedComment) {
      return JSON.stringify([comment.nickName, comment.content, comment.handle])
    },
  }
  return parser
}

export type TikTokDomParser = ReturnType<typeof createTikTokDomParser>
// This private, fixed source is never accepted from an API caller or platform configuration.
export const tikTokDomParserSource = createTikTokDomParser.toString()
