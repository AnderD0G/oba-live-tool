import type { Frame, Page } from 'playwright'
import type { PlatformPageDiagnostics } from '../../../../shared/platformPageDiagnostics'
import { type TikTokDomParser, tikTokDomParserSource } from './domCommentParser'

function livePageUrl(page: Page): string {
  if (page.isClosed()) throw new Error('TikTok diagnostic page is closed')
  let parsed: URL
  try {
    parsed = new URL(page.url())
  } catch {
    throw new Error('TikTok live page is required for diagnostics')
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    !(parsed.hostname === 'tiktok.com' || parsed.hostname.endsWith('.tiktok.com')) ||
    !/^\/@[^/]+\/live\/?$/.test(parsed.pathname)
  ) {
    throw new Error('TikTok live page is required for diagnostics')
  }
  return `${parsed.origin}${parsed.pathname}`
}

/** Reads only the existing owned page. It does not install listeners or control the browser. */
export async function readTikTokPageDiagnostics(
  page: Page,
  marker?: string,
): Promise<PlatformPageDiagnostics> {
  if (
    marker !== undefined &&
    (typeof marker !== 'string' ||
      [...marker].length < 1 ||
      [...marker].length > 128 ||
      new TextEncoder().encode(marker).byteLength > 512)
  ) {
    throw new Error('marker must contain 1–128 Unicode codepoints and at most 512 UTF-8 bytes')
  }
  const url = livePageUrl(page)
  let timer: ReturnType<typeof setTimeout> | undefined
  let navigated = false
  const mainFrame = page.mainFrame()
  const onNavigation = (frame: Frame) => {
    if (frame === mainFrame) navigated = true
  }
  try {
    page.on('framenavigated', onNavigation)
    const snapshot = page.evaluate(
      ({ expectedUrl, marker, parserSource }) => {
        // Recheck inside the single read operation, in case navigation happened just before evaluate.
        if (`${location.origin}${location.pathname}` !== expectedUrl)
          throw new Error('TikTok diagnostic page changed')
        const rowSelector = '.text-UIText1' as const
        const parser = new Function(`return (${parserSource})()`)() as TikTokDomParser
        const limits = {
          samples: 5,
          visibleComments: 25,
          children: 6,
          ancestorDepth: 3,
          visibilityAncestorDepth: 12,
          nickname: 128,
          content: 512,
          handle: 128,
          layoutSamples: 3,
          layoutDepth: 5,
          layoutNodes: 32,
          layoutLeafText: 128,
          layoutText: 1024,
        } as const
        let fieldsTruncated = false
        // Object methods serialize without build-time helper references in the page context.
        const dom = {
          bounded(value: string, limit: number) {
            const points = Array.from(value)
            if (points.length > limit) fieldsTruncated = true
            return points.slice(0, limit).join('')
          },
          basic(element: Element) {
            const classes = Array.from(element.classList)
            if (classes.length > 12) fieldsTruncated = true
            return {
              tag: dom.bounded(element.tagName.toLowerCase(), 32),
              classes: classes.slice(0, 12).map(value => dom.bounded(value, 64)),
              dataE2e: dom.bounded(element.getAttribute('data-e2e') || '', 128),
            }
          },
          structure(element: Element) {
            if (element.children.length > limits.children) fieldsTruncated = true
            return {
              ...dom.basic(element),
              childCount: element.children.length,
              children: Array.from(element.children).slice(0, limits.children).map(dom.basic),
            }
          },
          visible(element: Element) {
            const style = window.getComputedStyle(element)
            if (
              !element.getClientRects().length ||
              style.display === 'none' ||
              style.visibility === 'hidden' ||
              style.visibility === 'collapse' ||
              style.opacity === '0'
            )
              return false
            const rect = element.getBoundingClientRect()
            let left = Math.max(0, rect.left)
            let top = Math.max(0, rect.top)
            let right = Math.min(window.innerWidth, rect.right)
            let bottom = Math.min(window.innerHeight, rect.bottom)
            let ancestor = element.parentElement
            for (
              let depth = 0;
              ancestor && depth < limits.visibilityAncestorDepth;
              depth++, ancestor = ancestor.parentElement
            ) {
              const ancestorStyle = window.getComputedStyle(ancestor)
              const bounds = ancestor.getBoundingClientRect()
              if (/^(auto|scroll|hidden|clip)$/.test(ancestorStyle.overflowX)) {
                const clipLeft = bounds.left + ancestor.clientLeft
                left = Math.max(left, clipLeft)
                right = Math.min(right, clipLeft + ancestor.clientWidth)
              }
              if (/^(auto|scroll|hidden|clip)$/.test(ancestorStyle.overflowY)) {
                const clipTop = bounds.top + ancestor.clientTop
                top = Math.max(top, clipTop)
                bottom = Math.min(bottom, clipTop + ancestor.clientHeight)
              }
            }
            return right > left && bottom > top
          },
          layoutAllowed(element: Element) {
            if (
              element.closest(
                'input, textarea, select, option, [contenteditable], [data-e2e="room-chat-input-field"], script, style, template, noscript',
              )
            )
              return false
            if (!dom.visible(element)) return false
            let ancestor = element.parentElement
            for (
              let depth = 0;
              ancestor && depth < limits.visibilityAncestorDepth;
              depth++, ancestor = ancestor.parentElement
            ) {
              const style = window.getComputedStyle(ancestor)
              if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                style.visibility === 'collapse' ||
                style.opacity === '0'
              )
                return false
            }
            return true
          },
          layout(
            row: Element,
            parseStatus: 'noContent' | 'noUser',
          ): PlatformPageDiagnostics['layoutEvidence'][number] | undefined {
            const state = {
              inspected: 0,
              nodeCount: 0,
              textCharacters: 0,
              truncated: { depth: false, nodes: false, text: false },
            }
            const walker = {
              visit(
                element: Element,
                depth: number,
              ): PlatformPageDiagnostics['layoutEvidence'][number]['tree'] | undefined {
                if (state.inspected >= limits.layoutNodes) {
                  state.truncated.nodes = true
                  return undefined
                }
                state.inspected++
                if (!dom.layoutAllowed(element)) return undefined
                state.nodeCount++
                const node: PlatformPageDiagnostics['layoutEvidence'][number]['tree'] = {
                  ...dom.basic(element),
                  children: [],
                }
                if (element.children.length) {
                  if (depth >= limits.layoutDepth) state.truncated.depth = true
                  else
                    for (let index = 0; index < element.children.length; index++) {
                      if (state.inspected >= limits.layoutNodes) {
                        state.truncated.nodes = true
                        break
                      }
                      const child = walker.visit(element.children[index], depth + 1)
                      if (child) node.children.push(child)
                    }
                } else {
                  const points = Array.from((element.textContent || '').replace(/\s+/g, ' ').trim())
                  const count = Math.min(
                    limits.layoutLeafText,
                    limits.layoutText - state.textCharacters,
                  )
                  if (points.length > count) state.truncated.text = true
                  const text = points.slice(0, count).join('')
                  if (text) {
                    node.text = text
                    state.textCharacters += Array.from(text).length
                  }
                }
                return node
              },
            }
            const tree = walker.visit(row, 0)
            if (!tree) return undefined
            return {
              kind: 'chat-layout-evidence',
              parseStatus,
              tree,
              nodeCount: state.nodeCount,
              textCharacters: state.textCharacters,
              truncated: state.truncated,
            }
          },
        }
        const rows = document.querySelectorAll(rowSelector)
        const start = Math.max(0, rows.length - 500)
        const failures = { enterMessage: 0, noContent: 0, noUser: 0, ignored: 0 }
        const samples: PlatformPageDiagnostics['samples'] = []
        const visibleComments: PlatformPageDiagnostics['visibleComments'] = []
        const layoutRows: Array<{ row: Element; parseStatus: 'noContent' | 'noUser' }> = []
        let visibleRows = 0
        let visibleParsedRows = 0
        let parsedRows = 0
        let matchedRows = 0
        let visibleMatchedRows = 0
        const needle = marker?.toLowerCase()
        for (let index = start; index < rows.length; index++) {
          const row = rows[index]
          const isVisible = dom.visible(row)
          if (isVisible) visibleRows++
          if (needle !== undefined && (row.textContent || '').toLowerCase().includes(needle)) {
            matchedRows++
            if (isVisible) visibleMatchedRows++
          }
          const result = parser.parse(row)
          const parseStatus = result.parseStatus
          let parsed: PlatformPageDiagnostics['visibleComments'][number] | undefined
          if (result.parseStatus === 'parsed') {
            parsedRows++
            if (isVisible) {
              parsed = {
                nickname: dom.bounded(result.comment.nickName, limits.nickname),
                content: dom.bounded(result.comment.content, limits.content),
                handle: dom.bounded(result.comment.handle, limits.handle),
              }
              visibleParsedRows++
              visibleComments.push(parsed)
              if (visibleComments.length > limits.visibleComments) visibleComments.shift()
            }
          }
          if (parseStatus !== 'parsed') failures[parseStatus]++
          if (
            isVisible &&
            (parseStatus === 'noContent' || parseStatus === 'noUser') &&
            row.getAttribute('data-e2e') === 'chat-message' &&
            dom.layoutAllowed(row)
          ) {
            layoutRows.push({ row, parseStatus })
            if (layoutRows.length > limits.layoutSamples) layoutRows.shift()
          }
          if (isVisible) {
            samples.push({
              kind: 'chat-row',
              parseStatus,
              structure: dom.structure(row),
              ...(parsed ? { parsed } : {}),
            })
            if (samples.length > limits.samples) samples.shift()
          }
        }
        const candidates: PlatformPageDiagnostics['candidates'] = []
        const layoutEvidence = layoutRows.flatMap(({ row, parseStatus }) => {
          const evidence = dom.layout(row, parseStatus)
          return evidence ? [evidence] : []
        })
        let visibleCandidates = 0
        let candidatesScanTruncated = false
        if (!visibleParsedRows) {
          const usernameNodes = document.querySelectorAll(
            '[data-e2e="comment-username"], span[class*="username"]',
          )
          const candidateStart = Math.max(0, usernameNodes.length - 500)
          candidatesScanTruncated = candidateStart > 0
          for (let index = candidateStart; index < usernameNodes.length; index++) {
            const node = usernameNodes[index]
            if (!dom.visible(node)) continue
            visibleCandidates++
            const ancestors: PlatformPageDiagnostics['candidates'][number]['ancestors'] = []
            let parent = node.parentElement
            for (
              let depth = 0;
              parent && depth < limits.ancestorDepth;
              depth++, parent = parent.parentElement
            ) {
              if (parent === document.body || parent === document.documentElement) break
              ancestors.push(dom.structure(parent))
            }
            candidates.push({ kind: 'username-ancestor-candidate', ancestors })
            if (candidates.length > limits.samples) candidates.shift()
          }
        }
        const targetWindow = window as unknown as {
          __obaTikTokLiveComment?: unknown
          __obaTikTokCommentObserver?: unknown
          __obaTikTokCommentPoll?: unknown
        }
        return {
          platform: 'tiktok' as const,
          kind: 'page-snapshot' as const,
          url: expectedUrl,
          capturedAt: Date.now(),
          rowSelector,
          scan: {
            totalRows: rows.length,
            scannedRows: rows.length - start,
            visibleRows,
            parsedRows,
            parseFailures: failures,
            rowLimit: 500 as const,
            truncated: start > 0,
            order: 'last-500-dom-order' as const,
          },
          bridge: {
            commentFunctionType: typeof targetWindow.__obaTikTokLiveComment,
            observerType: typeof targetWindow.__obaTikTokCommentObserver,
            observerPresent: targetWindow.__obaTikTokCommentObserver != null,
            pollType: typeof targetWindow.__obaTikTokCommentPoll,
            pollPresent:
              targetWindow.__obaTikTokCommentPoll != null &&
              targetWindow.__obaTikTokCommentPoll !== 0,
          },
          samples,
          candidates,
          visibleComments,
          layoutEvidence,
          sampleOrder: 'last-visible-dom-rows' as const,
          truncation: {
            samples: visibleRows > limits.samples,
            visibleComments: visibleParsedRows > limits.visibleComments,
            candidates: candidatesScanTruncated || visibleCandidates > limits.samples,
            fields: fieldsTruncated,
          },
          ...(marker !== undefined
            ? {
                marker: {
                  value: marker,
                  scope: 'scanned-current-selector-rows' as const,
                  matchedRows,
                  visibleMatchedRows,
                  caseInsensitive: true as const,
                },
              }
            : {}),
          limits,
        }
      },
      { expectedUrl: url, marker, parserSource: tikTokDomParserSource },
    )
    let diagnostics: PlatformPageDiagnostics
    try {
      diagnostics = await Promise.race([
        snapshot,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('TikTok diagnostic snapshot timed out after 5 seconds')),
            5000,
          )
        }),
      ])
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'TikTok diagnostic snapshot timed out after 5 seconds'
      )
        throw error
      throw new Error(
        'TikTok diagnostic snapshot is unavailable; the page may have closed or navigated',
      )
    }
    if (page.isClosed()) throw new Error('TikTok diagnostic page is closed')
    if (navigated) throw new Error('TikTok diagnostic page navigated during the snapshot')
    let afterUrl: string
    try {
      afterUrl = livePageUrl(page)
    } catch {
      throw new Error('TikTok diagnostic page changed during the snapshot')
    }
    if (afterUrl !== url) throw new Error('TikTok diagnostic page changed during the snapshot')
    return diagnostics
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    page.off('framenavigated', onNavigation)
  }
}
