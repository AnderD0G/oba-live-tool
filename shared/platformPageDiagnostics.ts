/** A bounded DOM observation for comparison with the live event stream; never an event itself. */
export interface PublicPageComment {
  nickname: string
  content: string
  handle: string
}

export interface PageElementStructure {
  tag: string
  classes: string[]
  dataE2e: string
  childCount: number
  children: Array<Pick<PageElementStructure, 'tag' | 'classes' | 'dataE2e'>>
}

export interface PageChatRowSample {
  kind: 'chat-row'
  parseStatus: 'parsed' | 'ignored' | 'enterMessage' | 'noContent' | 'noUser'
  structure: PageElementStructure
  parsed?: PublicPageComment
}

export interface PageUsernameCandidate {
  /** These ancestors are structural candidates, not identified chat rows. */
  kind: 'username-ancestor-candidate'
  ancestors: PageElementStructure[]
}

export interface PageChatLayoutNode {
  tag: string
  classes: string[]
  dataE2e: string
  children: PageChatLayoutNode[]
  /** Public visible text on a genuine element leaf, never a subtree text aggregate. */
  text?: string
}

export interface PageChatLayoutEvidence {
  /** Failed chat layout evidence, never a successfully parsed comment or an event. */
  kind: 'chat-layout-evidence'
  parseStatus: 'noContent' | 'noUser'
  tree: PageChatLayoutNode
  nodeCount: number
  textCharacters: number
  truncated: { depth: boolean; nodes: boolean; text: boolean }
}

export interface TikTokWirePayloadRingSnapshot {
  received: number
  receivedBytes: number
  retained: number
  retainedBytes: number
  skippedOversize: number
  failed: number
  evictedTTL: number
  evictedCapacity: number
  firstReceivedAt: number | null
  lastReceivedAt: number | null
  firstRetainedAt: number | null
  lastRetainedAt: number | null
}

/** Limited in-memory SDK payload evidence, not a complete network archive or a platform event. */
export interface TikTokWireDiagnosticsSnapshot {
  kind: 'sdk-network-snapshot'
  capturedAt: number
  limits: {
    retentionMs: 180000
    maxEntriesPerRing: 256
    maxBytesPerRing: 4194304
    maxFrameBytes: 1048576
    maxInflatedBytes: 1048576
    maxMatches: 20
    maxPayloadsPerFrame: 256
  }
  frames: {
    received: number
    receivedBytes: number
    skippedOversize: number
    decodeFailed: number
    decompressFailed: number
    unsupportedPayloadType: number
    skippedPayloads: number
    firstReceivedAt: number | null
    lastReceivedAt: number | null
    payloads: TikTokWirePayloadRingSnapshot
  }
  decoded: TikTokWirePayloadRingSnapshot
  search?: {
    scope: 'current-retained-payloads'
    wirePayloadContainsMarker: number
    decodedPayloadContainsMarker: number
    truncated: boolean
    matches: Array<{
      source: 'wire' | 'decoded'
      receivedAt: number
      method: string
      payloadBytes: number
      sha256: string
    }>
  }
}

export interface PlatformPageDiagnostics {
  platform: 'tiktok'
  kind: 'page-snapshot'
  url: string
  capturedAt: number
  sdkNetwork?: TikTokWireDiagnosticsSnapshot
  rowSelector: '.text-UIText1'
  scan: {
    totalRows: number
    scannedRows: number
    /** Intersects the viewport and clipping bounds of up to 12 ancestors. */
    visibleRows: number
    /** Parse counts cover all scanned current-selector rows, including hidden rows. */
    parsedRows: number
    parseFailures: { enterMessage: number; noContent: number; noUser: number; ignored: number }
    rowLimit: 500
    truncated: boolean
    order: 'last-500-dom-order'
  }
  bridge: {
    commentFunctionType: string
    observerType: string
    observerPresent: boolean
    pollType: string
    pollPresent: boolean
  }
  /** Last five visible matched rows in DOM order; failed parses retain their structure. */
  samples: PageChatRowSample[]
  candidates: PageUsernameCandidate[]
  /** Last 25 parsed visible rows in DOM order, without synthesized message identifiers. */
  visibleComments: PublicPageComment[]
  /** Latest three visible exact chat-message failures; excludes editable and control subtrees. */
  layoutEvidence: PageChatLayoutEvidence[]
  sampleOrder: 'last-visible-dom-rows'
  truncation: { samples: boolean; visibleComments: boolean; candidates: boolean; fields: boolean }
  marker?: {
    value: string
    scope: 'scanned-current-selector-rows'
    matchedRows: number
    visibleMatchedRows: number
    caseInsensitive: true
  }
  limits: {
    samples: 5
    visibleComments: 25
    children: 6
    ancestorDepth: 3
    visibilityAncestorDepth: 12
    nickname: 128
    content: 512
    handle: 128
    layoutSamples: 3
    /** Root depth is zero. */
    layoutDepth: 5
    /** Inspected elements and returned nodes are both bounded by this limit per row. */
    layoutNodes: 32
    layoutLeafText: 128
    layoutText: 1024
  }
}
