import { useMemoizedFn } from 'ahooks'
import type { LogMessage } from 'electron-log'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import { useIpcListener } from '@/hooks/useIpc'
import { cn } from '@/lib/utils'

interface ParsedLog {
  id: string
  timestamp: string
  module: string
  level: string
  message: string
}

// interface LogMessage {
//   logId: string
//   date: Date
//   scope?: string
//   level: string
//   data: string[]
// }

const MAX_LOG_MESSAGES = 200 // 仅展示最近的 200 条日志

export default function LogDisplayer() {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('oba.logPanel.collapsed') !== 'false' }
    catch { return true }
  })
  const [logMessages, setLogMessages] = useState<ParsedLog[]>([])
  const [autoScroll, setAutoScroll] = useState(true)
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    try { localStorage.setItem('oba.logPanel.collapsed', String(collapsed)) } catch {}
  }, [collapsed])

  const scrollToBottom = useCallback(() => {
    if (viewportRef.current && autoScroll) {
      const scrollContainer = viewportRef.current
      requestAnimationFrame(() => {
        scrollContainer.scrollTop = scrollContainer.scrollHeight
      })
    }
  }, [autoScroll])

  useEffect(() => {
    if (!collapsed) scrollToBottom()
  }, [collapsed, scrollToBottom])

  const parseLogMessage = (log: LogMessage): ParsedLog | null => {
    if (!log.data || log.data.length === 0) {
      return null
    }
    return {
      id: crypto.randomUUID(),
      timestamp: log.date.toLocaleString(),
      module: log.scope ?? 'App',
      level: typeof log.level === 'string' ? log.level.toUpperCase() : 'INFO',
      // 只保留换行符之前的内容
      message: log.data.map(String).join(' ').split('\n')[0],
    }
  }

  useEffect(() => {
    // 监听 ScrollArea 的 viewport 元素
    if (scrollAreaRef.current) {
      const viewport = scrollAreaRef.current.querySelector<HTMLDivElement>(
        '[data-radix-scroll-area-viewport]',
      )
      if (viewport) {
        // 使用 MutableRefObject 来避免只读属性错误
        viewportRef.current = viewport
      }
    }
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: parseLogMessage 不影响
  const handleLogMessage = useCallback(
    (message: LogMessage) => {
      const parsed = parseLogMessage(message)
      if (parsed) {
        setLogMessages(prev => [...prev.slice(-MAX_LOG_MESSAGES + 1), parsed])
        if (autoScroll) {
          scrollToBottom()
        }
      }
    },
    [autoScroll, scrollToBottom],
  )

  useIpcListener(IPC_CHANNELS.log, handleLogMessage)

  const autoScrollId = useId()

  return (
    <div className={cn('flex flex-col bg-background shrink-0', collapsed ? 'h-[48px]' : 'h-[180px]')}>
      {/* 日志头部 */}
      <div className="flex items-center justify-between px-4 py-2 border-b">
        <div className="flex items-center gap-2">
          <h3 className="font-medium">运行日志</h3>
          <span className="text-xs text-muted-foreground">{logMessages.length} 条记录</span>
        </div>
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={!collapsed}
            onClick={() => setCollapsed(value => !value)}
          >
            {collapsed ? '展开日志' : '最小化日志'}
          </Button>
          {/* 自动滚动开关 */}
          <div className={cn('flex items-center gap-2', collapsed && 'hidden')}>
            <Switch id={autoScrollId} checked={autoScroll} onCheckedChange={setAutoScroll} />
            <label
              htmlFor={autoScrollId}
              className="text-xs text-muted-foreground cursor-pointer select-none"
            >
              自动滚动
            </label>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setLogMessages([])
              scrollToBottom()
            }}
            className={cn('text-xs h-7 px-2 text-muted-foreground hover:text-destructive', collapsed && 'hidden')}
          >
            清空
          </Button>
        </div>
      </div>

      {/* 日志内容 */}
      <ScrollArea ref={scrollAreaRef} className={cn('flex-1', collapsed && 'hidden')}>
        <div className="p-4 font-mono text-sm">
          {logMessages.map((log, index) => (
            <LogItem key={log.id} log={log} index={index} />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

function LogItem({ log, index }: { log: ParsedLog; index: number }) {
  const getLevelColor = useMemoizedFn((level: string): string => {
    switch (level.toUpperCase()) {
      case 'ERROR':
        return 'text-destructive font-medium'
      case 'FATAL':
        return 'text-destructive font-bold'
      case 'WARN':
        return 'text-warning font-medium'
      case 'DEBUG':
        return 'text-blue-600'
      case 'INFO':
        return 'text-muted-foreground'
      case 'SUCCESS':
        return 'text-emerald-600'
      case 'NOTE':
        return 'text-purple-600'
      default:
        return 'text-muted-foreground'
    }
  })
  return (
    <div
      key={log.id}
      className={cn(
        'flex gap-2 items-start py-1 whitespace-nowrap',
        index % 2 === 0 ? 'bg-muted/40' : 'bg-background',
      )}
    >
      <span className="text-muted-foreground shrink-0">[{log.timestamp}]</span>
      <span className="text-foreground/70 shrink-0">[{log.module}]</span>
      <span className={cn('shrink-0', getLevelColor(log.level))}>{log.level}</span>
      <span className="text-foreground truncate">{log.message}</span>
    </div>
  )
}
