import { Check, Copy, Loader2, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { CodexStatus } from 'shared/codexDraft'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useAccounts } from '@/hooks/useAccounts'

export const useDraftPreferences = create<{
  instructions: string
  model: string
  update: (settings: { instructions?: string; model?: string }) => void
}>()(
  persist(
    set => ({
      instructions:
        '用简体中文，语气友好自然，控制在 60 字以内。根据观众的问题直接回应，不编造未提供的信息。',
      model: '',
      update: settings => set(settings),
    }),
    { name: 'codex-draft-preferences' },
  ),
)

function DraftEditor({
  comment: initialComment,
  editable,
}: {
  comment: string
  editable: boolean
}) {
  const [comment, setComment] = useState(initialComment)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [progress, setProgress] = useState('')
  const [hasDraft, setHasDraft] = useState(false)
  const [timing, setTiming] = useState('')
  const active = useRef<string | null>(null)
  const { instructions, model } = useDraftPreferences()
  const inputId = useId()
  const draftId = useId()

  useEffect(
    () =>
      window.ipcRenderer.on(IPC_CHANNELS.codexDraft.progress, event => {
        if (event.requestId === active.current) {
          setProgress(event.message)
          if (event.text !== undefined) {
            setDraft(event.text)
            setHasDraft(true)
          }
        }
      }),
    [],
  )
  useEffect(() => {
    if (!busy) return
    const started = Date.now()
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [busy])

  useEffect(
    () => () => {
      if (active.current) {
        void window.ipcRenderer
          .invoke(IPC_CHANNELS.codexDraft.cancel, active.current)
          .catch(() => undefined)
        active.current = null
      }
    },
    [],
  )

  const generate = async () => {
    if (active.current) return
    const requestId = crypto.randomUUID()
    active.current = requestId
    setBusy(true)
    setError('')
    setCopied(false)
    setDraft('')
    setHasDraft(false)
    setElapsed(0)
    setTiming('')
    setProgress('正在启动 Codex…')
    try {
      const result = await window.ipcRenderer.invoke(IPC_CHANNELS.codexDraft.generate, {
        requestId,
        comment,
        instructions,
        model: model.trim() || undefined,
      })
      if (active.current !== requestId) return
      if (result.ok) {
        setDraft(result.text)
        setHasDraft(true)
        if (result.elapsedMs !== undefined)
          setTiming(
            `${result.firstTextMs !== undefined ? `首字 ${(result.firstTextMs / 1000).toFixed(1)} 秒 · ` : ''}完成 ${(result.elapsedMs / 1000).toFixed(1)} 秒`,
          )
      } else {
        setError(result.error)
        setDraft('')
        setHasDraft(false)
      }
    } catch {
      if (active.current === requestId) {
        setError('无法连接生成服务，请重启工具后重试')
        setDraft('')
        setHasDraft(false)
      }
    } finally {
      if (active.current === requestId) {
        active.current = null
        setBusy(false)
      }
    }
  }

  return (
    <div className="space-y-3">
      <Label htmlFor={inputId}>{editable ? '输入一条测试评论' : '观众评论'}</Label>
      <Textarea
        id={inputId}
        value={comment}
        onChange={event => setComment(event.target.value)}
        readOnly={!editable}
        disabled={busy}
        maxLength={4000}
        className="max-h-32"
      />
      <div className="flex items-center gap-2">
        <Button onClick={generate} disabled={busy || !comment.trim()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {busy ? 'Codex 正在拟写…' : draft ? '重新生成' : '生成回复草稿'}
        </Button>
        {busy && (
          <Button
            variant="outline"
            onClick={async () => {
              if (active.current)
                await window.ipcRenderer
                  .invoke(IPC_CHANNELS.codexDraft.cancel, active.current)
                  .catch(() => setError('取消失败，请稍后重试'))
            }}
          >
            取消生成
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {busy && (
        <p role="status" className="text-sm text-muted-foreground">
          {progress} 已等待 {elapsed} 秒。{elapsed >= 20 ? '可取消后重试，最多等待 120 秒。' : ''}
        </p>
      )}
      {hasDraft && (
        <div className="space-y-2" aria-live="polite">
          <Label htmlFor={draftId}>{busy ? '回复正在生成…' : '回复草稿 · 可编辑'}</Label>
          <Textarea
            id={draftId}
            value={draft}
            readOnly={busy}
            onChange={event => {
              setDraft(event.target.value)
              setCopied(false)
            }}
            rows={4}
          />
          <Button
            variant="outline"
            disabled={busy || !draft.trim()}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(draft)
                setCopied(true)
              } catch {
                setError('复制失败，请手动选中草稿复制')
              }
            }}
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? '已复制' : '复制草稿'}
          </Button>
        </div>
      )}
      {timing && <p className="text-xs text-muted-foreground">{timing}</p>}
      <p className="text-xs text-muted-foreground">
        点击生成会将这条评论和回复要求交给已登录的 Codex，使用账号额度。草稿不会自动发到直播间。
      </p>
    </div>
  )
}

export function CodexDraftButton({ comment, nickname }: { comment: string; nickname: string }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 text-primary"
          title="为这条评论生成回复草稿"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Codex 拟回复
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>给 {nickname || '观众'} 拟回复</DialogTitle>
          <DialogDescription>生成后可以修改、复制，或照着口播。</DialogDescription>
        </DialogHeader>
        <DraftEditor comment={comment} editable={false} />
      </DialogContent>
    </Dialog>
  )
}

export function CodexDraftSettings() {
  const [status, setStatus] = useState<CodexStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const { instructions, model, update } = useDraftPreferences()
  const accountId = useAccounts(state => state.currentAccountId)
  const promptId = useId()
  const modelId = useId()
  const check = useCallback(async () => {
    setChecking(true)
    try {
      setStatus(await window.ipcRenderer.invoke(IPC_CHANNELS.codexDraft.status))
    } catch {
      setStatus({ available: false, error: '无法检测 Codex CLI' })
    } finally {
      setChecking(false)
    }
  }, [])
  useEffect(() => {
    void check()
  }, [check])
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5" />
          Codex 评论草稿
        </CardTitle>
        <CardDescription>在下方评论旁点“Codex 拟回复”，由你挑选需要回应的评论。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span role="status">
            {checking
              ? '正在连接常驻 CLI…'
              : status?.available
                ? `Codex 常驻服务已就绪${status.pid ? ` · PID ${status.pid}` : ''}`
                : status?.error}
          </span>
          <Button variant="outline" size="sm" onClick={check} disabled={checking}>
            重新检测
          </Button>
          <Dialog key={accountId}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm">
                不直播，先试写
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>试写评论回复</DialogTitle>
                <DialogDescription>
                  这里是独立的草稿测试，不会创建直播或发送评论。
                </DialogDescription>
              </DialogHeader>
              <DraftEditor comment="主播，你用什么软件把手机画面传到电脑的？" editable />
            </DialogContent>
          </Dialog>
        </div>
        <details>
          <summary className="cursor-pointer text-sm font-medium">回复要求和模型</summary>
          <div className="grid gap-3 pt-3">
            <Label htmlFor={promptId}>主播的回复要求 / 已知直播信息</Label>
            <Textarea
              id={promptId}
              value={instructions}
              maxLength={6000}
              onChange={event => update({ instructions: event.target.value })}
              placeholder="例如：直播主题、已确认的产品信息、回复语气…"
            />
            <Label htmlFor={modelId}>模型（选填，留空使用 CLI 默认模型）</Label>
            <Input
              id={modelId}
              value={model}
              maxLength={100}
              onChange={event => update({ model: event.target.value })}
              placeholder="留空即可"
            />
            <p className="text-xs text-muted-foreground">
              这里只保存回复要求和模型，不保存评论草稿，也不需要填写 API Key。CLI 登录可在终端运行
              codex login。
            </p>
          </div>
        </details>
      </CardContent>
    </Card>
  )
}
