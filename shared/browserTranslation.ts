/** Passive browser rendering evidence. It never creates a platform comment or identity. */
export interface BrowserTranslationObservation {
  original: string
  chinese: string
  language?: string
  receivedAt: number
  source: 'chrome-google' | 'immersive-dom'
  captureGeneration: string
  observationId?: string
  /** Private DOM duplicate evidence; an empty Chinese value never becomes a translation. */
  ambiguous?: boolean
}
export interface LiveMessageTranslationMetadata {
  captureGeneration?: string
  provenance?: 'sdk-decoded' | 'cdp-websocket-decoded' | 'cdp-http-decoded' | 'dom-observation'
  translationObservation?: BrowserTranslationObservation
}
