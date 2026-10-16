import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { AssistantDeskState } from '../../../shared/assistantDesk'

export function BrowserTranslationNotice({
  accountId,
  sessionId,
  health,
}: {
  accountId: string
  sessionId?: string
  health?: AssistantDeskState['browserTranslationHealth']
}) {
  const [dismissed, setDismissed] = useState<string>()
  const episode = `${accountId}:${sessionId ?? ''}:${health?.noticeKey ?? health?.attentionSince ?? 'attention'}`
  useEffect(() => {
    if (health?.status !== 'attention' || !sessionId) setDismissed(undefined)
  }, [health?.status, sessionId])
  if (!sessionId || health?.status !== 'attention' || dismissed === episode) return null
  return (
    <div role="status" aria-live="polite" className="assistant-warning">
      <p>
        网页译文暂未收到。弹幕仍在收集，未翻译的消息保留原文。请检查翻译插件，必要时手动刷新直播页。
      </p>
      <Button size="sm" variant="ghost" onClick={() => setDismissed(episode)}>
        知道了
      </Button>
    </div>
  )
}
