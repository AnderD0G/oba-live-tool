import type { AssistantLocalTranslationHealth } from '../../../shared/assistantDesk'

const statusLabels: Record<AssistantLocalTranslationHealth['status'], string> = {
  idle: 'Chrome 本地翻译待命',
  starting: 'Chrome 本地翻译准备中',
  ready: 'Chrome 本地翻译已就绪',
  failed: 'Chrome 本地翻译暂不可用',
  unavailable: 'Chrome 本地翻译不受支持',
}

const errorLabels = new Map([
  ['LOCAL_TRANSLATION_FAILED', '本地翻译失败，请稍后重试'],
  ['LOCAL_TRANSLATION_API_UNAVAILABLE', '当前 Chrome 不支持本地翻译'],
  ['LOCAL_TRANSLATION_TIMEOUT', '本地翻译超时，原文已保留'],
  ['LOCAL_TRANSLATION_CLOSED', '本地翻译服务已关闭'],
  ['LOCAL_TRANSLATION_CANCELLED', '本地翻译已取消，原文已保留'],
  ['LOCAL_TRANSLATION_QUEUE_FULL', '本地翻译队列已满，原文已保留'],
])

export function LocalTranslationNotice({ health }: { health?: AssistantLocalTranslationHealth }) {
  const error = health?.lastError ? errorLabels.get(health.lastError) ?? health.lastError : undefined
  return (
    <div role="status" aria-live="polite" className="assistant-panel assistant-muted">
      <p>
        <strong>{statusLabels[health?.status ?? 'idle']}</strong>
        {health && ` · 待翻译 ${health.queued} 条`}
        {!!health?.activeLanguages.length && ` · 已加载语言：${health.activeLanguages.join('、')}`}
      </p>
      <p>
        首次使用可能下载语言包并等待数秒；本地翻译无按次付费，不占用 AI 请求额度，也不受 AI 暂停影响。
        支持情况以当前 Chrome 实际检测为准，并非所有语言都可翻译；不支持或语言识别不确定时保留原文及原因。
        手动 DeepSeek 翻译计入 AI 额度。
      </p>
      {error && <p className="assistant-warning">{error}</p>}
    </div>
  )
}
