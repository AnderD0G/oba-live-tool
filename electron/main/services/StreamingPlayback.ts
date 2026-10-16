import { setTimeout as delay } from 'node:timers/promises'
import type { AdaptiveSpeechStream } from './AdaptiveSpeechStream'

/** Pause a network source before it consumes audible samples; HTTP streams cannot be rewound. */
export async function waitForPausedStream(
  pause: () => Promise<unknown>, readStatus: () => Promise<Record<string, unknown>>,
  signal: AbortSignal, stream: AdaptiveSpeechStream,
) {
  const end = Date.now() + 5000
  // Bound every RPC by the same load deadline.
  const rpc = async <T>(request: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted()
    stream.check()
    const remaining = end - Date.now()
    if (remaining <= 0) throw new Error('OBS 流式语音载入超时')
    const cancel = new AbortController()
    try {
      const result = await Promise.race([
        request(),
        delay(remaining, undefined, { signal: AbortSignal.any([signal, cancel.signal]) })
          .then(() => { throw new Error('OBS 流式语音载入超时') }),
      ])
      signal.throwIfAborted()
      stream.check()
      if (Date.now() >= end) throw new Error('OBS 流式语音载入超时')
      return result
    } catch (error) {
      signal.throwIfAborted()
      throw error
    } finally { cancel.abort() }
  }
  let parsedPauseSent=false
  while (Date.now() < end) {
    signal.throwIfAborted()
    stream.check()
    const state = await rpc(readStatus)
    if (state.mediaState === 'OBS_MEDIA_STATE_ERROR' || state.mediaState === 'OBS_MEDIA_STATE_ENDED')
      throw new Error('OBS 流式语音载入失败')
    // A negative unknown duration is OBS's valid parsed-network-stream marker; zero is not ready.
    if (state.mediaState === 'OBS_MEDIA_STATE_PAUSED' && typeof state.mediaDuration === 'number' && state.mediaDuration !== 0){
      if(typeof state.mediaCursor!=='number'||!Number.isFinite(state.mediaCursor)||state.mediaCursor<0||
        state.mediaCursor>stream.preloadGuardSeconds*1000)
        throw new Error('OBS 预载可能已消耗句首，保留原讲解并转文字')
      return
    }
    // Pause only after parsing, then await its state change. An early PAUSE is
    // not a reliable barrier; repeated PAUSE wakes OBS's
    // network media thread and repeatedly adds the current PTS to its base_ts,
    // delaying audible output even though the reported cursor still advances.
    if (!parsedPauseSent&&state.mediaState === 'OBS_MEDIA_STATE_PLAYING'&&
      typeof state.mediaDuration==='number'&&state.mediaDuration!==0){
      parsedPauseSent=true
      await rpc(pause)
    }
    await delay(Math.min(10, Math.max(1, end - Date.now())), undefined, { signal })
  }
  throw new Error('OBS 流式语音载入超时')
}

/** Only OBS EOF + complete synthesis/encoding can confirm a streaming reply. */
export async function waitForSpeechPlayback(
  stream: AdaptiveSpeechStream,
  readStatus: () => Promise<Record<string, unknown>>,
  signal: AbortSignal,
  deadline: number,
) {
  if (!Number.isFinite(deadline)) throw new Error('互动语音窗口截止时间无效')
  let lastCursor = -1
  let progressedAt = Date.now()
  for (;;) {
    signal.throwIfAborted()
    stream.check()
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('互动语音未能在窗口截止前播完')
    const cancel = new AbortController()
    let state: Record<string, unknown>
    try {
      state = await Promise.race([
        readStatus(),
        delay(remaining, undefined, { signal: AbortSignal.any([signal, cancel.signal]) })
          .then(() => { throw new Error('互动语音状态查询超过窗口截止时间') }),
      ])
    } finally { cancel.abort() }
    signal.throwIfAborted()
    stream.check()
    if (Date.now() >= deadline) throw new Error('互动语音未能在窗口截止前播完')
    const cursor = typeof state.mediaCursor === 'number' ? state.mediaCursor / 1000 : Number.NaN
    if (state.mediaState === 'OBS_MEDIA_STATE_ENDED') {
      if (!stream.finished || Math.max(Number.isFinite(cursor) ? cursor : -1, lastCursor) + 0.2 < stream.duration)
        throw new Error('OBS 提前结束，未确认完整互动语音')
      return
    }
    if (state.mediaState === 'OBS_MEDIA_STATE_ERROR' || state.mediaState === 'OBS_MEDIA_STATE_STOPPED')
      throw new Error('互动流式语音解码失败或已停止')
    if (Number.isFinite(cursor) && cursor > lastCursor + 0.005) {
      lastCursor = cursor
      progressedAt = Date.now()
    } else if (!(stream.finished && lastCursor + 0.2 >= stream.duration) &&
      Date.now() - progressedAt > (lastCursor <= 0 ? 1500 : 700))
      throw new Error('流式播放缓冲耗尽，改发文字')
    await delay(Math.min(20, Math.max(1, deadline - Date.now())), undefined, { signal })
  }
}
