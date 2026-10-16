import type { AnalysisCapabilities, AnalysisSession } from '../../../shared/analysisRoom'

export function captureTransportPresentation(transports?: AnalysisCapabilities['captureTransports']) {
  if (!transports) return undefined
  if (transports.browserNetwork === 'active' && transports.sdk !== 'connected') {
    return transports.webpage === 'active'
      ? '浏览器原生事件与网页补充均在采集中'
      : '浏览器原生事件采集中；网页补充不可用'
  }
  if (transports.webpage === 'active') {
    if (transports.sdk === 'connected') return 'SDK 与网页补充均在采集中'
    if (transports.sdk === 'connecting') return '网页采集中；SDK 原始事件流正在连接'
    return '仅网页采集；SDK 原始事件流不可用，网页记录不会补写为原始事件'
  }
  if (transports.sdk === 'connected') return 'SDK 原始事件流采集中；网页补充不可用'
  if (transports.sdk === 'connecting') return 'SDK 原始事件流正在连接；网页补充未启动'
  if (transports.sdk === 'idle' && transports.webpage === 'idle') return '采集通道未启动'
  return '采集通道不可用，请检查直播页后重新开始采集'
}

export function sessionPresentation(session: AnalysisSession) {
  const originals = session.originals
  const originalDetails = originals
    ? ` · 原始解码事件保存 ${originals.saved} / ${originals.received} · 原始待写 ${originals.pending} · 原始丢弃 ${originals.dropped}${originals.error ? ` · ${originals.error}` : ''}`
    : ''
  return {
    lifecycle: {
      completed: '采集已停止',
      collecting: '正在采集',
      stopping: '正在排空保存',
      interrupted: '采集已中断',
      'storage-error': '保存异常，证据已保留',
    }[session.status],
    integrity: session.complete ? '数据完整' : '数据不完整',
    details: `保存 ${session.counters.saved} / 接收 ${session.counters.received} · 待写 ${session.counters.pending} · 丢弃 ${session.counters.dropped} · 解析失败 ${session.counters.parseFailed}${session.reason ? ` · ${session.reason}` : ''}${originalDetails}`,
  }
}
