import { useEffect, useRef, useState } from 'react'
import type { DirectorCommand, DirectorStep } from 'shared/director'
import { directorStepAudioFiles } from 'shared/director'
import type { SpeechWindow } from 'shared/directorNarration'
import { speechMaterialConfiguration, type SpeechCandidate, type TranscriptSpan } from 'shared/directorSpeechAnalysis'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { useAccounts } from '@/hooks/useAccounts'

async function call(command: DirectorCommand) {
  const result = await window.ipcRenderer.invoke(IPC_CHANNELS.director.request, command)
  if (!result.ok) throw new Error(result.error || '操作失败')
  return result
}

const primary =
  'rounded border border-primary bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50'
const secondary = 'rounded border px-3 py-1.5 text-sm disabled:opacity-50'
const inputClass = 'w-full rounded border bg-background px-2 py-1.5 text-sm'

type Candidate = SpeechCandidate

/**
 * 互动插入点编辑器。
 *
 * 三步：分析 → 勾选 → 生成。分析只读；生成只改本地草稿（apply=false），
 * 由页面原有的「保存」按钮统一落盘 —— 否则直接写账本会和页面的草稿打架，
 * 用户再点一次保存就会把刚生成的插入点覆盖掉。
 *
 * 「试听这句」在本机播放原配音的 [start, end] 片段 —— 这就是候选项的标签：
 * 不用 ASR，听一遍就知道那句话是什么。
 */
export function SpeechSlots({
  step,
  update,
}: {
  step: DirectorStep
  update: (patch: Partial<DirectorStep>) => void
}) {
  const accountId = useAccounts(s => s.currentAccountId)
  const files = directorStepAudioFiles(step)
  const [selectedAudio, setSelectedAudio] = useState('')
  const audio = files.includes(selectedAudio) ? selectedAudio : files[0] || ''
  const materialKey = speechMaterialConfiguration(step)
  const currentKey = `${accountId}:${materialKey}:${audio}`
  const keyRef = useRef(currentKey)
  keyRef.current = currentKey
  const [analysisId, setAnalysisId] = useState('')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [originals, setOriginals] = useState<Record<string, string>>({})
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({})
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [transcriptJson, setTranscriptJson] = useState('')
  const requestGeneration = useRef(0)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [previewText, setPreviewText] = useState('你好呀')
  const [replyUrl, setReplyUrl] = useState('')
  const [mixedUrl, setMixedUrl] = useState('')
  const [fit, setFit] = useState<{ reply: number; window: number; ok: boolean } | null>(null)

  const clip = useRef<HTMLAudioElement>(null)
  const stopAt = useRef(0)

  // 素材换了，之前的分析结果就作废
  useEffect(() => {
    setAnalysisId('')
    setCandidates([])
    setPicked({})
    setOriginals({})
    setConfirmed({})
    setReasons({})
    setTranscriptJson('')
    setReplyUrl('')
    setMixedUrl('')
    setFit(null)
    setNotice('')
    setError('')
    setBusy('')
    requestGeneration.current++
    if (clip.current) {
      clip.current.pause()
      clip.current.removeAttribute('src')
      clip.current.load()
    }
  }, [currentKey])

  const saved: SpeechWindow[] = (step.speechWindows || []).filter(w => w.audio === audio)

  async function analyze() {
    if (!audio) {
      setError('这个步骤还没有配音，先添加一个配音版本')
      return
    }
    setBusy('analyze')
    setError('')
    setNotice('')
    const generation = ++requestGeneration.current
    setAnalysisId('')
    setCandidates([])
    try {
      const transcript: TranscriptSpan[] | undefined = transcriptJson.trim() ? JSON.parse(transcriptJson) : undefined
      const result = await call({
        action: 'speech-analyze',
        input: { stepId: step.id, audio, material: { video: step.file }, transcript },
      })
      if (keyRef.current !== currentKey || generation !== requestGeneration.current) return
      const analysis = result.analysis
      if (!analysis) throw new Error('分析没有返回结果')
      if (analysis.material?.configuration !== materialKey)
        throw new Error('当前草稿与已保存的素材配对不同，请先保存步骤，再重新分析')
      setAnalysisId(analysis.analysisId)
      setCandidates(analysis.candidates as Candidate[])
      // 默认全部不勾 —— 关键讲解要用户自己判断能不能被顶掉
      setPicked({})
      setOriginals(Object.fromEntries(analysis.candidates.map(c => [c.id, c.text])))
      setConfirmed({})
      setReasons({})
      setNotice(
        analysis.candidates.length
          ? `找到 ${analysis.candidates.length} 个待审核候选（原配音 ${analysis.duration.toFixed(2)} 秒）。自动切段不代表完整句子，请逐条试听审核。`
          : '未找到满足条件的候选。可提供带时间戳的完整分句逐字稿后重新分析。',
      )
    } catch (e) {
      if (keyRef.current === currentKey && generation === requestGeneration.current)
        setError(String(e instanceof Error ? e.message : e))
    } finally {
      if (generation === requestGeneration.current) setBusy('')
    }
  }

  function playClip(start: number, end: number) {
    setError('')
    void (async () => {
      try {
        const element = clip.current
        if (!element) return
        if (!element.src) {
          const result = await call({ action: 'preview-file', file: audio })
          if (keyRef.current !== currentKey) return
          element.src = result.url || ''
        }
        stopAt.current = end
        element.currentTime = start
        await element.play()
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e))
      }
    })()
  }

  async function generate() {
    if (!analysisId) {
      setError('分析已过期，请重新点「分析插入点」')
      return
    }
    setBusy('plan')
    setError('')
    const generation = ++requestGeneration.current
    try {
      const result = await call({
        action: 'speech-plan',
        analysisId,
        selections: candidates.map(c => ({
          candidateId: c.id,
          replaceable: Boolean(picked[c.id]),
          // 校验器要求逐句给理由；这里由用户勾选，理由照实写。
          reason: picked[c.id] ? reasons[c.id] || '' : '用户选择保留原句',
          text: originals[c.id],
          completeSentence: confirmed[c.id],
        })),
        apply: false,
      })
      if (keyRef.current !== currentKey || generation !== requestGeneration.current) return
      const step0 = result.ops?.[0] as { step?: { speechWindows?: SpeechWindow[] } } | undefined
      const windows = step0?.step?.speechWindows
      if (!windows) throw new Error('生成失败：没有拿到插入点')
      update({ speechWindows: windows, speechSlot: false })
      setNotice(
        `已生成 ${windows.length} 个插入点（本地草稿）。**记得点页面上的「保存」**才会生效。`,
      )
    } catch (e) {
      if (keyRef.current === currentKey && generation === requestGeneration.current)
        setError(String(e instanceof Error ? e.message : e))
    } finally {
      if (generation === requestGeneration.current) setBusy('')
    }
  }

  async function preview() {
    const text = previewText.trim()
    if (!text) {
      setError('先输入要试听的文字')
      return
    }
    const target =
      saved[0] || (candidates.find(c => picked[c.id]) as SpeechWindow | undefined) || candidates[0]
    if (!target) {
      setError('先分析并选择一个插入点')
      return
    }
    setBusy('preview')
    setError('')
    const generation = ++requestGeneration.current
    try {
      const result = await call({
        action: 'speech-preview',
        accountId,
        audio,
        start: target.start,
        end: target.end,
        text,
      })
      if (keyRef.current !== currentKey || generation !== requestGeneration.current) return
      setReplyUrl(result.replyUrl || '')
      setMixedUrl(result.mixedUrl || '')
      setFit({
        reply: result.replyDuration || 0,
        window: result.windowDuration || 0,
        ok: Boolean(result.fits),
      })
    } catch (e) {
      if (keyRef.current === currentKey && generation === requestGeneration.current)
        setError(String(e instanceof Error ? e.message : e))
    } finally {
      if (generation === requestGeneration.current) setBusy('')
    }
  }

  const pickedCount = candidates.filter(c => picked[c.id]).length
  const canApprove = (c: Candidate) => Boolean(reasons[c.id]?.trim() && confirmed[c.id] &&
    (c.kind === 'silence' || originals[c.id]?.trim()))

  return (
    <div className="space-y-3 rounded border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">整句替换 / 静音插入审核</p>
        <button type="button" className={secondary} disabled={Boolean(busy) || !audio} onClick={analyze}>
          {busy === 'analyze' ? '分析中…' : '分析插入点'}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        自动分析仅提出候选。静音之间可能有半句或多句，不能直接批准。
        请试听前后文，填写准确原句和替换理由，逐句确认完整性。整句已经开始就跳过，关键商品讲解应保留。
      </p>
      <p className="break-all text-xs text-muted-foreground">配对视频：{step.file || '尚未设置'}（{step.start} — {step.end || '末尾'} 秒）</p>
      <select aria-label="审核配音版本" className={inputClass} value={audio} onChange={e => setSelectedAudio(e.target.value)}>
        {files.map(file => <option key={file} value={file}>{file}</option>)}
      </select>
      <details>
        <summary className="cursor-pointer text-xs">已有分句逐字稿（可选）</summary>
        <textarea className={inputClass} rows={3} value={transcriptJson}
          onChange={e => { setTranscriptJson(e.target.value); setAnalysisId(''); setCandidates([]) }}
          placeholder={'[{"start":0,"end":3,"text":"完整原句。"}]'} />
      </details>

      {notice && <p className="rounded border bg-muted/40 p-2 text-xs">{notice}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}

      {candidates.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs">
            <button type="button" className={secondary} onClick={() => setPicked({})}>
              全不选
            </button>
            <span className="text-muted-foreground">已勾选 {pickedCount} 个</span>
          </div>
          {candidates.map(candidate => (
            <div
              key={candidate.id}
              className="flex flex-wrap items-center gap-2 rounded border p-2 text-xs"
            >
              <input
                type="checkbox"
                checked={Boolean(picked[candidate.id])}
                aria-label={`批准 ${candidate.id}`}
                disabled={Boolean(busy) || !canApprove(candidate)}
                onChange={e =>
                  setPicked(current => ({ ...current, [candidate.id]: e.target.checked }))
                }
              />
              <span>{candidate.kind === 'silence' ? '静音插入' : candidate.kind === 'sentence' ? '整句替换' : '待确认有声段'}</span>
              <span className="tabular-nums">
                {candidate.start.toFixed(2)} — {candidate.end.toFixed(2)}
              </span>
              <span className="text-muted-foreground">
                {(candidate.end - candidate.start).toFixed(2)} 秒
              </span>
              {candidate.text && <span className="truncate">{candidate.text}</span>}
              <button
                type="button"
                className={`${secondary} ml-auto`}
                onClick={() => playClip(candidate.start, candidate.end)}
              >
                试听这句
              </button>
              <button type="button" className={secondary}
                onClick={() => playClip(Math.max(0, candidate.start - 2), candidate.end + 2)}>试听前后文</button>
              {candidate.kind !== 'silence' && <input className={inputClass} aria-label="准确原句"
                value={originals[candidate.id] || ''} readOnly={candidate.kind === 'sentence'} maxLength={2000}
                placeholder="听清后填写完整原句；半句、多句或不确定的片段请保留"
                onChange={e => { setOriginals(v => ({ ...v, [candidate.id]: e.target.value })); setPicked(v => ({ ...v, [candidate.id]: false })); setConfirmed(v => ({ ...v, [candidate.id]: false })) }} />}
              <input className={inputClass} aria-label="审核理由" maxLength={500}
                value={reasons[candidate.id] || ''} placeholder="说明为什么允许替换 / 插入"
                onChange={e => { setReasons(v => ({ ...v, [candidate.id]: e.target.value })); setPicked(v => ({ ...v, [candidate.id]: false })) }} />
              <label className="w-full"><input type="checkbox" checked={Boolean(confirmed[candidate.id])}
                onChange={e => { setConfirmed(v => ({ ...v, [candidate.id]: e.target.checked })); setPicked(v => ({ ...v, [candidate.id]: false })) }} />{' '}
                {candidate.kind === 'silence' ? '已试听确认整段没有原句，可在剩余静音中插入' : '已试听前后文，确认这是可省略的一句完整原句'}</label>
            </div>
          ))}
          <button
            type="button"
            className={primary}
            disabled={Boolean(busy) || !analysisId || candidates.some(c => picked[c.id] && !canApprove(c))}
            onClick={generate}
          >
            {busy === 'plan' ? '生成中…' : `保存审核到草稿（批准 ${pickedCount} 个）`}
          </button>
        </div>
      )}

      <div className="space-y-2 rounded border border-dashed p-2">
        <p className="text-sm">试听插入效果</p>
        <div className="flex gap-2">
          <input
            className={inputClass}
            value={previewText}
            placeholder="输入要插入的话，例如：你好呀"
            onChange={e => setPreviewText(e.target.value)}
          />
          <button
            type="button"
            className={secondary}
            disabled={Boolean(busy)}
            onClick={preview}
          >
            {busy === 'preview' ? '合成中…' : '合成并试听'}
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          用当前第一个插入点（{saved[0] ? `${saved[0].start.toFixed(2)} — ${saved[0].end.toFixed(2)}` : '生成后会显示'}）。
          试听会把原配音在这段静音、把合成语音叠上去 —— 就是你直播时观众听到的效果。
        </p>
        {fit && (
          <p className={`text-xs ${fit.ok ? 'text-green-600' : 'text-amber-600'}`}>
            合成语音 {fit.reply.toFixed(2)} 秒 / 插入点 {fit.window.toFixed(2)} 秒 ——{' '}
            {fit.ok ? '时长合适；实际播放仍需通过句首、素材和有效期检查' : '放不下，保留原配音'}
          </p>
        )}
        {replyUrl && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">只含合成的这句话：</p>
            {/* biome-ignore lint/a11y/useMediaCaption: 本机预览没有字幕轨 */}
            <audio controls src={replyUrl} className="w-full" />
          </div>
        )}
        {mixedUrl && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">完整效果（原配音 + 插入）：</p>
            {/* biome-ignore lint/a11y/useMediaCaption: 本机预览没有字幕轨 */}
            <audio controls src={mixedUrl} className="w-full" />
          </div>
        )}
      </div>

      {/* 隐藏播放器：只用来播原配音的某个片段 */}
      {/* biome-ignore lint/a11y/useMediaCaption: 本机预览没有字幕轨 */}
      <audio
        ref={clip}
        className="hidden"
        onTimeUpdate={e => {
          if (stopAt.current && e.currentTarget.currentTime >= stopAt.current) {
            e.currentTarget.pause()
          }
        }}
      />
    </div>
  )
}
