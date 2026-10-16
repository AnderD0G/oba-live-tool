import type { SpeechMaterial, TranscriptSpan } from './directorSpeechAnalysis'
/** User-approved 5s→3s replacement; add only the verified 100ms entry guard. */
export const MAX_SENTENCE_PADDING_SECONDS=2.1

/** Do not add a two-second replacement pause on top of an existing authored gap. */
export function sentencePaddingAllowance(window:{end:number},windows:Array<{start:number;end:number;kind?:string}>){
  const following=windows.find(w=>w.kind==='silence'&&Math.abs(w.start-window.end-.1)<.003)
  const authoredGap=following?following.end-following.start+.2:0
  return Math.min(MAX_SENTENCE_PADDING_SECONDS,Math.max(.1,3.2-authoredGap-.65))
}

export interface SpeechWindow {
  audio: string
  start: number
  end: number
  /** Earliest safe pause inside measured silence immediately before the sentence. */
  entryStart?: number
  /** Missing is a legacy sentence replacement, never permission to enter midway. */
  kind?: 'sentence' | 'silence'
  transcript?: TranscriptSpan
  review?: { analysisId: string; candidateId: string; reason: string; reviewedAt: string }
  material?: SpeechMaterial
}

/** No tolerance after a sentence starts. Only verified silence permits late entry. */
export function speechWindowMissed(window: SpeechWindow, cursor: number) {
  return !Number.isFinite(cursor) || cursor >= window.end ||
    (window.kind !== 'silence' && cursor > window.start)
}

export function speechWindowEntryStart(window: SpeechWindow) {
  return window.kind === 'silence' ? window.start : window.entryStart ?? window.start
}

export function isReviewedSpeechWindow(window: SpeechWindow) {
  return Boolean(window.material && window.review &&
    (window.kind === 'silence' || (window.kind === 'sentence' &&
      typeof window.transcript?.text === 'string' && window.transcript.text.trim())))
}
export function narrationSegments(audio: string, duration: number, windows: SpeechWindow[]) {
  const selected = windows
    .filter(window => window.audio === audio)
    .sort((a, b) => a.start - b.start)
  const segments: { start: number; end: number; replaceable: boolean }[] = []
  let cursor = 0
  for (const window of selected) {
    if (window.entryStart !== undefined && (!Number.isFinite(window.entryStart) ||
      window.entryStart < cursor || window.entryStart > window.start))
      throw new Error('句前静音进入点无效或与前一句重叠')
    if (window.kind !== undefined && !['sentence', 'silence'].includes(window.kind))
      throw new Error('语音窗口类型无效')
    if (window.kind !== undefined || window.review !== undefined || window.material !== undefined || window.transcript !== undefined) {
      if (!isReviewedSpeechWindow(window) ||
        !window.review?.analysisId || !window.review.candidateId ||
        typeof window.review.reason !== 'string' || !window.review.reason.trim() ||
        window.review.reason.length > 500 || !Number.isFinite(Date.parse(window.review.reviewedAt)) ||
        !window.material?.audioVersion || !window.material.videoVersion || !window.material.configuration)
        throw new Error('语音窗口缺少完整审核或素材配对信息，请重新分析')
      if (window.kind === 'sentence') {
        const transcript = window.transcript!
        if (!Number.isFinite(transcript.start) || !Number.isFinite(transcript.end) ||
          transcript.start < window.start || transcript.end > window.end || transcript.end <= transcript.start ||
          typeof transcript.text !== 'string' || !transcript.text.trim() || transcript.text.length > 2000)
          throw new Error('替换窗口必须包含完整原句及时间戳')
      }
    }
    if (
      ![window.start, window.end].every(Number.isFinite) ||
      window.start < cursor ||
      window.end <= window.start ||
      window.end > duration
    )
      throw new Error('配音气口重叠或超出录音时长')
    if (window.start > cursor)
      segments.push({ start: cursor, end: window.start, replaceable: false })
    segments.push({ start: window.start, end: window.end, replaceable: true })
    cursor = window.end
  }
  if (cursor < duration) segments.push({ start: cursor, end: duration, replaceable: false })
  return segments
}
