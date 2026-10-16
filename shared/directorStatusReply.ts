import type { DirectorViewerContext } from './director'

export function directorStatusReply(context?: Partial<DirectorViewerContext>) {
  if (!context) return '我暂时查不到你的点播进度。'
  const active = context.yourActive
  if (active) {
    const label = `${active.productId}号${active.mode === 'C' ? '试戴' : '展示'}`
    if (active.status === 'cancelling') return `${label}正在收尾，这一段结束就停。`
    return active.status === 'preparing' ? `正在切到你点的${label}。` : `现在正在播你点的${label}。`
  }
  const queued = context.yourQueue?.[0]
  if (queued)
    return `${queued.productId}号${queued.mode === 'C' ? '试戴' : '展示'}还在排队，前面还有${queued.position - 1}个排队点播${context.nowPlaying ? '，当前这段也还没结束' : ''}。`
  const ended = context.recentRequests?.[0]
  if (!ended) return '还没查到你的点播，想看哪款可以告诉我编号。'
  const label = `${ended.productId}号${ended.mode === 'C' ? '试戴' : '展示'}`
  if (ended.status === 'completed') return `你点的${label}已经播完了。`
  if (ended.status === 'cancelled') return `你点的${label}已经取消了。`
  return `你点的${label}中途停止了，没有确认完整播完。`
}
