import type { AssistantDeskMarkerStatus, AssistantDeskResult, AssistantDeskRow, AssistantDeskState } from './assistantDesk'
import type { AudiencePolicyTier } from './assistantAudiencePolicy'
import type { ObsCameraTarget } from './obsCamera'

export const MOBILE_ASSISTANT_ACTIONS = ['attention-pin', 'attention-defer', 'reply-dismiss', 'attention-countdown', 'reply-update', 'reply-translate', 'reply-approve', 'segment-toggle', 'translate-retry'] as const
export type MobileAssistantAction = typeof MOBILE_ASSISTANT_ACTIONS[number]

export interface MobileAssistantAccessStatus {
  active: boolean
  accountId?: string
  urls: string[]
  startedAt?: number
}
export interface MobileAssistantAccessCommand { action: 'status' | 'start' | 'stop'; accountId: string }
export type MobileAssistantAccessResult = AssistantDeskResult<MobileAssistantAccessStatus>
export type MobileAssistantCameraCommand = { action: 'status' } | { action: 'switch'; target: ObsCameraTarget }
export interface MobileAssistantCameraState {
  available: boolean
  selected?: ObsCameraTarget | 'both' | 'none'
  androidEnabled?: boolean
  iphoneEnabled?: boolean
  onProgram?: boolean
  message: string
}
export type MobileStudioMicCommand = { action: 'status' | 'toggle' | 'align-open' | 'mute' | 'unmute' }

export interface MobileAssistantDeskSnapshot {
  provenance?: AssistantDeskState['provenance']
  mockReplyTarget?: AssistantDeskState['mockReplyTarget']
  accountId: string
  accountName: string
  serverNow: number
  collecting: boolean
  /** An owned capture can remain active while audit storage is degraded. */
  captureActive?: boolean
  captureStatus?: 'collecting' | 'storage-error'
  sessionId?: string
  rows: AssistantDeskRow[]
  tasks: AssistantDeskRow[]
  totalTasks: number
  pinnedRowIds: string[]
  marker: AssistantDeskMarkerStatus
  window?: { id: string; startedAt: number; endsAt: number; intervalSeconds: number; active?: boolean; paused?: boolean; remainingMs?: number }
  room: AssistantDeskState['room']
  ai: AssistantDeskState['ai']
  health: AssistantDeskState['health']
  audienceRules: { id: string; label: string; tier: AudiencePolicyTier; color?: string }[]
}
