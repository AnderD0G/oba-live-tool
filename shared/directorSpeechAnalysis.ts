import type { DirectorStep } from './director'

/** Explicit pair is checked against the configured step; omitted uses its configured video. */
export interface SpeechMaterialInput { video: string; variantId?: string }
export interface SpeechMaterial extends SpeechMaterialInput {
  stepId: string
  audio: string
  configuration: string
  audioVersion: string
  videoVersion: string
}
export interface SpeechAnalysisInput {
  stepId: string
  audio: string
  transcript?: TranscriptSpan[]
  material?: SpeechMaterialInput
}
export interface SpeechSelection {
  candidateId: string
  replaceable: boolean
  reason: string
  /** Required after listening when ASR did not supply a sentence. */
  text?: string
  completeSentence?: boolean
}

/** Only material-affecting fields: saving review metadata must not invalidate itself. */
export function speechMaterialConfiguration(step: DirectorStep) {
  return JSON.stringify([step.id, step.kind, step.file, step.start, step.end,
    step.audio, step.audioOverflow || 'continue', step.overlayGroup || '',
    step.overlayVariants || [], step.stepGroup || ''])
}

export interface TranscriptSpan {
  start: number
  end: number
  text: string
}
export interface SilenceSpan {
  start: number
  end: number
}
export interface SpeechCandidate extends TranscriptSpan {
  id: string
  replaceable: false
  kind: 'sentence' | 'silence' | 'unreviewed'
  transcript?: TranscriptSpan
  entryStart?: number
}
export function parseSilences(log: string, duration: number): SilenceSpan[] {
  const spans: SilenceSpan[] = []
  let start: number | undefined
  for (const match of log.matchAll(/silence_(start|end):\s*(-?[\d.]+)/g)) {
    const value = Math.max(0, Math.min(duration, Number(match[2])))
    if (!Number.isFinite(value)) continue
    if (match[1] === 'start') start = value
    else if (start !== undefined && value > start) {
      spans.push({ start, end: value })
      start = undefined
    }
  }
  if (start !== undefined && start < duration) spans.push({ start, end: duration })
  return spans
}
/** ASR supplies the timing; silence can refine it, never invent missing transcript timing. */
export function speechCandidates(
  transcript: TranscriptSpan[],
  silences: SilenceSpan[],
  duration: number,
): SpeechCandidate[] {
  if (!Array.isArray(transcript) || transcript.length > 2000)
    throw new Error('逐字稿必须是带时间戳的分句数组（最多 2000 句）')
  let last = 0
  for (const item of transcript) {
    if (
      !item ||
      !Number.isFinite(item.start) ||
      !Number.isFinite(item.end) ||
      item.start < last ||
      item.end <= item.start ||
      item.end > duration ||
      typeof item.text !== 'string' ||
      !item.text.trim() ||
      item.text.length > 2000
    )
      throw new Error('逐字稿时间戳重叠、超出时长或文字无效')
    last = item.end
  }
  // Refuse cuts without acoustic evidence on both sides. A pause alone does not approve replacement.
  const boundary = (time: number) => {
    if (time <= 0.08) return 0
    if (duration - time <= 0.08) return duration
    const near = silences
      .filter(s => time >= s.start && time <= s.end)
      .sort(
        (a, b) => Math.abs((a.start + a.end) / 2 - time) - Math.abs((b.start + b.end) / 2 - time),
      )[0]
    // Preserve the supplied sentence boundary. A nearby midpoint can cut its first/last word.
    return near ? time : undefined
  }
  const result: SpeechCandidate[] = []
  for (let i = 0; i < transcript.length; i++) {
    const item = transcript[i]
    const start = boundary(item.start)
    const end = boundary(item.end)
    if (
      start === undefined ||
      end === undefined ||
      end - start < 1.2 ||
      end - start > 12 ||
      start < (result.at(-1)?.end ?? 0)
    )
      continue
    const entryStart = sentenceEntryStart(start, silences, transcript[i - 1]?.end ?? 0)
    result.push({ id: `sentence-${i}`, start, end, text: item.text.trim(),
      ...(entryStart < start ? { entryStart } : {}),
      kind: 'sentence', transcript: { ...item, text: item.text.trim() }, replaceable: false })
  }
  return result
}

/** Acoustic proposals only. Speech between two pauses is not necessarily a complete sentence. */
export function silenceCandidates(
  silences: SilenceSpan[],
  duration: number,
): SpeechCandidate[] {
  const points: number[] = [0]
  for (const span of silences) {
    const middle = (span.start + span.end) / 2
    if (middle > 0.08 && middle < duration - 0.08 && middle > points[points.length - 1])
      points.push(middle)
  }
  // Use the measured file end, never truncate the last syllable to manufacture a margin.
  points.push(duration)

  const result: SpeechCandidate[] = []
  for (let index = 0; index < points.length - 1; index++) {
    const start = points[index]
    const end = points[index + 1]
    if (end - start < 1.2 || end - start > 12) continue
    const entryStart = sentenceEntryStart(start, silences, 0)
    result.push({ id: `gap-${result.length}`, start, end, text: '', kind: 'unreviewed',
      ...(entryStart < start ? { entryStart } : {}), replaceable: false })
  }
  return result
}

function sentenceEntryStart(start: number, silences: SilenceSpan[], previousEnd: number) {
  const silence = silences.find(s => s.start <= start && s.end >= start)
  return silence ? Math.min(start, Math.max(previousEnd, silence.start + 0.02)) : start
}

/** Only the inside of an acoustically measured silent interval allows mid-window insertion. */
export function silentInsertionCandidates(silences: SilenceSpan[]): SpeechCandidate[] {
  return silences.filter(s => s.end - s.start >= 1.4).map((s, i) => ({
    id: `silence-${i}`, start: s.start + 0.1, end: s.end - 0.1,
    text: '', kind: 'silence', replaceable: false,
  }))
}
