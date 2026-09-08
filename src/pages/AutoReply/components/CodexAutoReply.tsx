import { useId, useState } from 'react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
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
  const enabled = state.enabled && state.accountId === currentAccountId
  if (platform !== 'xiaohongshu') return null
  return (
    <div className="pt-3 space-y-2">
      <div className="flex items-center gap-2">
        <Switch
          id={id}
          checked={enabled}
          disabled={busy || (!enabled && (!connected || !listening))}
          onCheckedChange={async enabled => {
            setBusy(true)
            setError('')
            try {
              if (enabled) useAutoReplyStore.getState().setIsRunning(currentAccountId, false)
              const result = await window.ipcRenderer.invoke(IPC_CHANNELS.codexAuto.configure, {
                accountId: currentAccountId,
                enabled,
                instructions,
                model: model.trim() || undefined,
                blockList: config.blockList,
              })
              if (!result.ok) setError(result.error || '设置失败')
              useCodexAutoStore
                .getState()
                .update(await window.ipcRenderer.invoke(IPC_CHANNELS.codexAuto.state))
            } catch {
              setError('无法更新自动回复，请重试')
            } finally {
              setBusy(false)
            }
          }}
        />
        <Label htmlFor={id} className="font-medium">
          Codex 自动回复 · 生成后发送
        </Label>
      </div>
      <p className="text-xs text-muted-foreground">
        使用开启时的回复要求与模型；仅处理新文字评论，跳过自己和重复消息。每条发送后至少间隔 5 秒。
      </p>
      <p className="text-xs text-muted-foreground">
        关闭会取消待处理回复；已经提交给平台的消息无法撤回。断开监听或重启后需重新开启。
      </p>
      {(state.accountId === currentAccountId || error) && (
        <p
          role="status"
          className={`text-xs ${error ? 'text-destructive' : 'text-muted-foreground'}`}
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
            <span className="text-xs text-muted-foreground">Codex 回复 · {record.nickname}</span>
            <span className={record.phase === 'sent' ? 'text-green-700' : ''}>
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
