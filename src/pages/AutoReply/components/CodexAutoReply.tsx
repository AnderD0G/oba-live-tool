import { useId, useState } from 'react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useAccounts } from '@/hooks/useAccounts'
import { useAutoReplyStore } from '@/hooks/useAutoReply'
import { useAutoReplyConfig } from '@/hooks/useAutoReplyConfig'
import { useCodexAutoStore } from '@/hooks/useCodexAutoReply'
import { useCurrentLiveControl } from '@/hooks/useLiveControl'
import { useDraftPreferences } from './CodexDraft'

export function CodexAutoToggle({ listening }: { listening: boolean }) {
  const id = useId()
  const { currentAccountId } = useAccounts()
  const state = useCodexAutoStore(s => s.state)
  const connected = useCurrentLiveControl(s => s.isConnected === 'connected')
  const platform = useCurrentLiveControl(s => s.platform)
  const { config } = useAutoReplyConfig()
  const { instructions, model } = useDraftPreferences()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [voiceStatus, setVoiceStatus] = useState('')
  const enabled = state.enabled && state.accountId === currentAccountId
  if (!['xiaohongshu', 'tiktok'].includes(platform)) return null
  async function configure(delivery: 'text' | 'voice', next: boolean) {
    setBusy(true)
    setError('')
    try {
      const result = await window.ipcRenderer.invoke(IPC_CHANNELS.codexAuto.configure, {
        accountId: currentAccountId,
        enabled: next,
        delivery,
        instructions,
        model: model.trim() || undefined,
        blockList: config.blockList,
      })
      if (!result.ok) setError(result.error || '设置失败')
      else if (next) useAutoReplyStore.getState().setIsRunning(currentAccountId, false)
      useCodexAutoStore
        .getState()
        .update(await window.ipcRenderer.invoke(IPC_CHANNELS.codexAuto.state))
    } catch {
      setError('无法更新自动回复，请重试')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="pt-3 space-y-3">
      {(['text', 'voice'] as const).map(delivery => {
        const checked = enabled && (state.delivery ?? 'text') === delivery
        return (
          <div className="flex items-center gap-2" key={delivery}>
            <Switch
              id={`${id}-${delivery}`}
              checked={checked}
              disabled={busy || (!checked && (!connected || !listening || state.enabled))}
              onCheckedChange={next => configure(delivery, next)}
            />
            <Label htmlFor={`${id}-${delivery}`} className="font-medium">
              {delivery === 'voice'
                ? '自动语音回复 · AI 生成后送入声卡'
                : 'Codex 自动文字回复 · 生成后发送'}
            </Label>
          </div>
        )
      })}
      <p className="text-xs text-muted-foreground">
        文字回复与语音回复二选一，切换前先关闭当前模式。语音模式用现有 Codex CLI
        写回复，再调用本地语音台；不会另发一条文字评论。
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              const result = await window.ipcRenderer.invoke(IPC_CHANNELS.codexAuto.voiceStatus)
              setVoiceStatus(result.message)
            } catch {
              setVoiceStatus('无法检查语音台连接')
            } finally {
              setBusy(false)
            }
          }}
        >
          检查语音台连接
        </Button>
      </div>
      {voiceStatus && (
        <p className="text-xs text-muted-foreground" role="status">
          {voiceStatus}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        使用开启时的回复要求与模型；只处理新文字评论，过滤自己和重复消息。依次播报，每条完成后间隔至少
        5 秒。
      </p>
      <p className="text-xs text-muted-foreground">
        关闭会取消本轮待处理回复和对应语音；已经播出的内容无法撤回。断开监听或重启后需重新开启。
      </p>
      {(state.accountId === currentAccountId || error) && (
        <p
          role="status"
          className={error ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
        >
          {error || state.message}
        </p>
      )}
    </div>
  )
}

const labels = {
  queued: '排队中',
  generating: '生成中',
  sending: '发送中',
  sent: '已发送',
  speaking: '语音合成/播报中',
  spoken: '声卡播放完成',
  failed: '未确认/失败',
  cancelled: '已取消',
  skipped: '已跳过',
}
export function CodexAutoHistory() {
  const accountId = useAccounts(s => s.currentAccountId)
  const records = useCodexAutoStore(s => s.state.records).filter(r => r.accountId === accountId)
  return (
    <div className="space-y-3">
      {records.map(record => (
        <div
          key={`${record.accountId}:${record.id}`}
          className="rounded border p-3 text-sm space-y-1"
        >
          <div className="flex justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {record.delivery === 'voice' ? '语音回复' : 'Codex 回复'} · {record.nickname}
            </span>
            <span
              className={
                record.phase === 'sent' || record.phase === 'spoken' ? 'text-green-700' : ''
              }
            >
              {labels[record.phase]}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">评论：{record.comment}</p>
          {record.text && <p className="break-words whitespace-pre-wrap">{record.text}</p>}
          <p className="text-xs text-muted-foreground">{record.detail}</p>
        </div>
      ))}
    </div>
  )
}
