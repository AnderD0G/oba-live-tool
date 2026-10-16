import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { type DirectorConfig, type DirectorStep, directorStepAudioFiles } from '../../../shared/director'
import { narrationSegments, type SpeechWindow } from '../../../shared/directorNarration'
import type { DirectorOp, DirectorStepPath } from '../../../shared/directorOps'
import {
  parseSilences,
  silenceCandidates,
  silentInsertionCandidates,
  speechCandidates,
  speechMaterialConfiguration,
  type SpeechAnalysisInput,
  type SpeechSelection,
  type SpeechMaterial,
} from '../../../shared/directorSpeechAnalysis'
import { DirectorMedia, runMediaCommand } from './DirectorMedia'

export type { SpeechAnalysisInput, SpeechSelection } from '../../../shared/directorSpeechAnalysis'

async function materialVersion(file: string) {
  const s = await stat(file)
  return JSON.stringify([s.size, s.mtimeMs, s.ctimeMs])
}

/** Recheck persisted approvals before playback, including same-path file replacements. */
export async function validateSpeechMaterials(step: DirectorStep, windows = step.speechWindows || []) {
  const versions = new Map<string, string>()
  for (const window of windows) {
    const material = window.material
    if (!material) continue // Legacy windows retain strict sentence-entry semantics.
    if (material.stepId !== step.id || material.audio !== window.audio || material.video !== step.file ||
      material.configuration !== speechMaterialConfiguration(step))
      throw new Error('配对配置或素材已改变，请重新分析')
    for (const [file, version] of [[window.audio, material.audioVersion], [step.file, material.videoVersion]]) {
      if (!versions.has(file)) versions.set(file, await materialVersion(file))
      if (versions.get(file) !== version) throw new Error('配对素材已改变，请重新分析')
    }
  }
}
export class DirectorSpeechAnalysis {
  private busy = false
  private analyses = new Map<
    string,
    {
      config: string
      material: SpeechMaterial
      duration: number
      input: SpeechAnalysisInput
      path: DirectorStepPath
      candidates: ReturnType<typeof speechCandidates>
      expires: number
    }
  >()
  constructor(private cache: string) {}
  private locate(config: DirectorConfig, input: SpeechAnalysisInput) {
    const entries = config.trays
      .flatMap(t => [
        ...t.A.map(step => ({ step, path: { trayId: t.id, mode: 'A' as const } })),
        ...t.products.flatMap(p =>
          (['B', 'C'] as const).flatMap(mode =>
            p[mode].map(step => ({ step, path: { trayId: t.id, productId: p.id, mode } })),
          ),
        ),
      ])
      .filter(
        entry =>
          entry.step.id === input.stepId &&
          directorStepAudioFiles(entry.step).includes(input.audio),
      )
    if (entries.length !== 1) throw new Error('需要唯一的已配置步骤 id 和该步骤的配音文件')
    const step = entries[0].step
    if (input.material && (input.material.video !== step.file ||
      (input.material.variantId !== undefined && !step.overlayVariants?.some(v =>
        v.id === input.material!.variantId && v.audio.includes(input.audio)))))
      throw new Error('素材配对与步骤中的视频或配音搭配不一致')
    if (
      entries[0].step.kind === 'image' ||
      (entries[0].step.audioOverflow || 'continue') !== 'continue'
    )
      throw new Error('仅连续视频配音支持气口替换')
    return entries[0]
  }
  async analyze(config: DirectorConfig, input: SpeechAnalysisInput) {
    if (this.busy) throw new Error('正在分析另一段配音，请稍后重试')
    input = structuredClone(input)
    const configSnapshot = JSON.stringify(config)
    const { path, step } = this.locate(config, input)
    this.busy = true
    try {
      const signal = AbortSignal.timeout(120000)
      const material: SpeechMaterial = {
        stepId: step.id, audio: input.audio, video: step.file,
        ...(input.material?.variantId ? { variantId: input.material.variantId } : {}),
        configuration: speechMaterialConfiguration(step),
        audioVersion: await materialVersion(input.audio), videoVersion: await materialVersion(step.file),
      }
      const media = new DirectorMedia(config, this.cache)
      const duration = await media.duration(input.audio, signal)
      if (duration > 3600) throw new Error('单段配音最长支持 1 小时')
      const log = await runMediaCommand(
        config.ffmpeg,
        [
          '-hide_banner',
          '-nostdin',
          '-i',
          input.audio,
          '-vn',
          '-af',
          'silencedetect=noise=-35dB:d=0.16',
          '-f',
          'null',
          '-',
        ],
        signal,
        true,
      )
      const silences = parseSilences(log, duration)
      const candidates = [ ...(
        input.transcript && input.transcript.length
          ? speechCandidates(input.transcript, silences, duration)
          : silenceCandidates(silences, duration)), ...silentInsertionCandidates(silences)]
        .sort((a, b) => a.start - b.start)
      if (configSnapshot !== JSON.stringify(config) ||
        material.audioVersion !== (await materialVersion(input.audio)) ||
        material.videoVersion !== (await materialVersion(step.file)))
        throw new Error('分析中素材已改变，请重新分析')
      const analysisId = randomUUID()
      for (const [id, entry] of this.analyses)
        if (entry.expires < Date.now()) this.analyses.delete(id)
      if (this.analyses.size >= 20) this.analyses.delete(this.analyses.keys().next().value!)
      this.analyses.set(analysisId, {
        config: configSnapshot,
        material,
        duration,
        input: structuredClone(input),
        path,
        candidates,
        expires: Date.now() + 1800000,
      })
      return {
        analysisId,
        material: structuredClone(material),
        duration,
        candidates: structuredClone(candidates),
        silences,
        requiresSemanticReview: true,
        saved: false,
      }
    } finally {
      this.busy = false
    }
  }
  async plan(
    config: DirectorConfig,
    analysisId: string,
    selections: SpeechSelection[],
  ): Promise<DirectorOp[]> {
    const analysis = this.analyses.get(analysisId)
    if (!analysis || analysis.expires < Date.now()) throw new Error('分析已过期，请重新分析')
    if (
      analysis.config !== JSON.stringify(config) ||
      analysis.material.audioVersion !== (await materialVersion(analysis.input.audio)) ||
      analysis.material.videoVersion !== (await materialVersion(analysis.material.video))
    )
      throw new Error('配置或素材已改变，请重新分析')
    if (!Array.isArray(selections) || selections.length !== analysis.candidates.length)
      throw new Error('AI 必须逐句标注所有候选；无法判断的句子必须保留')
    const ids = new Set<string>()
    for (const selection of selections) {
      if (
        !selection ||
        !analysis.candidates.some(c => c.id === selection.candidateId) ||
        ids.has(selection.candidateId) ||
        typeof selection.replaceable !== 'boolean' ||
        typeof selection.reason !== 'string' ||
        !selection.reason.trim() ||
        selection.reason.length > 500
      )
        throw new Error('AI 标注无效、重复或缺少理由')
      ids.add(selection.candidateId)
    }
    const { step } = this.locate(config, analysis.input)
    const windows: SpeechWindow[] = selections
      .filter(s => s.replaceable)
      .map(s => {
        const c = analysis.candidates.find(c => c.id === s.candidateId)!
        if (c.kind === 'unreviewed' && (s.completeSentence !== true ||
          typeof s.text !== 'string' || !s.text.trim() || s.text.length > 2000))
          throw new Error('未提供逐字稿的候选必须填写原句并确认是完整句子')
        return { audio: analysis.input.audio, start: c.start, end: c.end,
          ...(c.entryStart !== undefined ? { entryStart: c.entryStart } : {}),
          kind: c.kind === 'silence' ? 'silence' : 'sentence',
          ...(c.kind === 'silence' ? {} : { transcript: c.transcript || { start: c.start, end: c.end, text: s.text!.trim() } }),
          review: { analysisId, candidateId: c.id, reason: s.reason.trim(), reviewedAt: new Date().toISOString() },
          material: structuredClone(analysis.material),
        }
      })
    windows.sort((a, b) => a.start - b.start)
    // Never enter a leading pause still owned by another approved replacement.
    for (let i = 1; i < windows.length; i++)
      if (windows[i].entryStart !== undefined)
        windows[i].entryStart = Math.max(windows[i].entryStart!, windows[i - 1].end)
    if (windows.length > 50) throw new Error('单段最多 50 个替换窗口')
    narrationSegments(analysis.input.audio, analysis.duration, windows)
    return [
      {
        op: 'upsertStep',
        path: analysis.path,
        step: {
          id: step.id,
          speechSlot: false,
          speechWindows: [
            ...(step.speechWindows || []).filter(w => w.audio !== analysis.input.audio),
            ...windows,
          ],
        },
      },
    ]
  }
}
