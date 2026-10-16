import { SendHorizontalIcon } from 'lucide-react'
import { useState } from 'react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { useAccounts } from '@/hooks/useAccounts'
import { type MessageOf, useAutoReply } from '@/hooks/useAutoReply'
import { useCodexAutoStore } from '@/hooks/useCodexAutoReply'
import { useCurrentLiveControl } from '@/hooks/useLiveControl'
import { useToast } from '@/hooks/useToast'
import { CodexAutoHistory } from './CodexAutoReply'

export default function PreviewList({
  setHighLight,
}: {
  setHighLight: (commentId: string | null) => void
}) {
  const { replies, comments } = useAutoReply()
  const { currentAccountId } = useAccounts()
  const isConnected = useCurrentLiveControl(context => context.isConnected)
  const { toast } = useToast()
  const [manualMessage, setManualMessage] = useState('')
  const [isSendingManual, setIsSendingManual] = useState(false)
  const hasCodexReplies = useCodexAutoStore(s =>
    s.state.records.some(r => r.accountId === currentAccountId),
  )
  const handleSendReply = async (replyContent: string, _commentId: string) => {
    try {
      await window.ipcRenderer.invoke(
        IPC_CHANNELS.tasks.autoReply.sendReply,
        currentAccountId,
        replyContent,
      )
      // removeReply(commentId)
    } catch (error) {
      console.error('发送回复失败:', error)
    }
  }

  const handleManualSubmit = async () => {
    const content = manualMessage.trim()
    if (!content || isSendingManual) return
    setIsSendingManual(true)
    try {
      const sent = await window.ipcRenderer.invoke(
        IPC_CHANNELS.tasks.autoReply.sendReply,
        currentAccountId,
        content,
      )
      if (!sent) throw new Error('发送任务未能启动')
      setManualMessage('')
      toast.success('评论已发送')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '发送评论失败')
    } finally {
      setIsSendingManual(false)
    }
  }

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle>回复预览</CardTitle>
        <CardDescription>AI 生成的回复内容</CardDescription>
      </CardHeader>
      <Separator />
      <CardContent>
        <div className="flex gap-2 pt-4">
          <Input
            value={manualMessage}
            onChange={event => setManualMessage(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void handleManualSubmit()
              }
            }}
            placeholder="输入要发到直播间的评论，例如：你好"
            disabled={isConnected !== 'connected' || isSendingManual}
          />
          <Button
            onClick={() => void handleManualSubmit()}
            disabled={
              isConnected !== 'connected' || isSendingManual || manualMessage.trim().length === 0
            }
          >
            <SendHorizontalIcon className="h-4 w-4" />
            {isSendingManual ? '发送中' : '发送'}
          </Button>
        </div>
        <ScrollArea className="py-2 h-[400px]">
          <div className="space-y-1">
            <CodexAutoHistory />
            {replies.length === 0 && !hasCodexReplies ? (
              <div className="text-center text-muted-foreground py-8">暂无回复数据</div>
            ) : (
              replies.map(reply => {
                const relatedComment = comments.find(
                  c => c.msg_id === reply.commentId,
                ) as MessageOf<'comment'>
                return (
                  // biome-ignore lint/a11y/noStaticElementInteractions: 不用管 a11y
                  <div
                    key={reply.commentId}
                    className="group px-3 py-1.5 text-sm hover:bg-muted/50 rounded-lg transition-colors"
                    onMouseEnter={() => setHighLight(reply.commentId)}
                    onMouseLeave={() => setHighLight(null)}
                  >
                    <div className="flex flex-col gap-1">
                      {relatedComment && (
                        <div className="text-xs text-muted-foreground">
                          回复：
                          {relatedComment.nick_name} - {relatedComment.content}
                        </div>
                      )}
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-gray-700 flex-1">{reply.replyContent}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="invisible group-hover:visible h-6 w-6"
                          title="发送"
                          onClick={() => handleSendReply(reply.replyContent, reply.commentId)}
                        >
                          <SendHorizontalIcon className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}
