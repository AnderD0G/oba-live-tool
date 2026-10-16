import type { PlatformLiveTarget, PlatformLoginSnapshot } from '../../../../shared/platformSession'

export function matchesManualReplyTarget(
  snapshot: PlatformLoginSnapshot & { sessionId?: string; busy?: boolean },
  expected: { sessionId: string; target: PlatformLiveTarget },
): boolean {
  return (
    !snapshot.busy &&
    snapshot.browserOpen &&
    snapshot.loginStatus === 'authenticated' &&
    snapshot.roomReady &&
    snapshot.sessionId === expected.sessionId &&
    !!snapshot.target &&
    snapshot.target.username.toLowerCase() === expected.target.username.toLowerCase() &&
    snapshot.target.url.toLowerCase() === expected.target.url.toLowerCase()
  )
}
