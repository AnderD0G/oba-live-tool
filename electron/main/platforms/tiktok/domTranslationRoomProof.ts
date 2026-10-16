import type { TikTokBrowserNetworkOptions, TikTokBrowserNetworkHandle } from './browserNetwork'
import type { Page } from 'playwright'

const leases = new Set<symbol>()
type StartNetwork = (options: TikTokBrowserNetworkOptions) => Promise<TikTokBrowserNetworkHandle>
const startNetworkDefault: StartNetwork = async options => (await import('./browserNetwork')).startTikTokBrowserNetwork(options)

/** Verifies only a secondary page's room; never records or dispatches platform events. */
export async function startDomTranslationRoomProof(options: { page: Page; expectedRoomId: string; isCurrent(): boolean; now?(): number }, startNetwork: StartNetwork = startNetworkDefault) {
  if (leases.size >= 8) throw new Error('Secondary room verification capacity reached')
  const lease = Symbol('secondary-room-proof'); leases.add(lease)
  const now = options.now ?? Date.now
  let alive = true, verifiedAt = -Infinity
  let handle: TikTokBrowserNetworkHandle
  try { handle = await startNetwork({ page: options.page, expectedRoomId: options.expectedRoomId,
    allowHttp: true, isCurrent: () => alive && options.isCurrent(), onFrame: () => {},
    onDecoded: (_method, data, _binary, transport) => {
      if (!alive || !options.isCurrent() || transport?.staleTransport) return false
      const room = (data as { common?: { roomId?: unknown } } | null)?.common?.roomId
      const id = typeof room === 'string' && /^[1-9]\d{7,19}$/.test(room) ? room : transport?.roomId
      if (!id) return false
      if (id !== options.expectedRoomId || (transport?.roomId && transport.roomId !== id)) { verifiedAt = -Infinity; return false }
      verifiedAt = now()
      return true
    } }) } catch (error) { leases.delete(lease); throw error }
  let stopTask: Promise<void> | undefined
  return { verified: () => {
      if (!alive || !options.isCurrent()) return false
      const state = handle.snapshot()
      if (state.status !== 'active' || state.http?.commentHealthReason === 'http-room-mismatch' ||
        ['session-detached', 'socket-closed', 'socket-error'].includes(state.commentHealthReason)) { verifiedAt = -Infinity; return false }
      return now() >= verifiedAt && now() - verifiedAt <= 30000
    },
    stop: async () => {
      alive = false; verifiedAt = -Infinity
      if (!stopTask) {
        try { stopTask = Promise.resolve(handle.stop()).finally(() => leases.delete(lease)) }
        catch (error) { leases.delete(lease); stopTask = Promise.reject(error) }
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([stopTask, new Promise<void>(resolve => { timer = setTimeout(resolve, 3000) })]) }
      finally { if (timer) clearTimeout(timer) }
    } }
}
