import type {
  AssistantDeskCaptureRun,
  AssistantDeskSegment,
  AssistantDeskSession,
} from '../../../shared/assistantDesk'
import { displayTime } from './presentation'

export interface SegmentCaptureGroup {
  key: string
  sessionId: string
  session?: AssistantDeskSession
  run?: AssistantDeskCaptureRun
  captureSessionId?: string
  segments: AssistantDeskSegment[]
}

export function currentCaptureRun(session?: AssistantDeskSession) {
  return session?.captureRuns?.find(run => run.captureSessionId === session.captureSessionId)
}

export function captureRoomLabel(run?: AssistantDeskCaptureRun) {
  return run?.target?.username ? `@${run.target.username}` : '直播间未知'
}

export function assistantSceneLabel(session?: AssistantDeskSession) {
  if (!session) return '直播间未知 · 采集时间未知'
  const run = currentCaptureRun(session) ??
    (session.captureRuns?.length === 1 ? session.captureRuns[0] : undefined)
  const room = captureRoomLabel(run)
  return `${room}${run?.target?.username ? '的直播' : ''} · ${displayTime(session.startedAt, true)}—${session.status === 'collecting' ? '进行中' : displayTime(session.endedAt, true)}`
}

export function groupSegmentsByCapture(
  sessions: AssistantDeskSession[],
  segments: AssistantDeskSegment[],
  accountId: string,
): SegmentCaptureGroup[] {
  const scenes = new Map(sessions.filter(session => session.accountId === accountId).map(session => [session.id, session]))
  const groups = new Map<string, SegmentCaptureGroup>()
  for (const segment of segments) {
    if (segment.accountId !== accountId) continue
    const session = scenes.get(segment.sessionId)
    // Never use the scene's latest capture as a fallback for an unlinked segment.
    const captureSessionId = segment.captureSessionId
    const run = captureSessionId ? session?.captureRuns?.find(value => value.captureSessionId === captureSessionId) : undefined
    const key = `${segment.sessionId}:${captureSessionId ?? 'unknown'}`
    let group = groups.get(key)
    if (!group) {
      group = { key, sessionId: segment.sessionId, session, run, captureSessionId, segments: [] }
      groups.set(key, group)
    }
    group.segments.push(segment)
  }
  return [...groups.values()].sort((a, b) =>
    (b.run?.startedAt ?? b.segments[0].startedAt) - (a.run?.startedAt ?? a.segments[0].startedAt),
  )
}
