import type { ObsCameraTarget } from './obsCamera'

export const OBS_CAMERA_RECORDING_FILTERS = {
  iphone: 'OBA 独立录像 · iPhone',
  android: 'OBA 独立录像 · 小米4K',
} as const

export type ObsCameraRecordingCommand =
  | { action: 'status' }
  | { action: 'start'; requestId: string }
  | { action: 'stop'; runId: string; requestId: string }
  | { action: 'mark'; runId: string; requestId: string; label?: string }

export interface ObsCameraRecordingCamera {
  target: ObsCameraTarget
  sourceName: string
  filterName: string
  active: boolean
  owned: boolean
  outputPath?: string
  outputDurationMs?: number
  error?: string
}

export interface ObsCameraRecordingMark {
  runId: string
  requestId: string
  sequence: number
  target: ObsCameraTarget
  sourceName: string
  filterName: string
  programScene: string
  /** Exact user label, kept separately from the unique chapter name. */
  label: string
  chapterName: string
  outputPath: string
  /** Approximate OBS frame duration sampled before delivery, excluding pauses. Final embedded chapter PTS can differ. */
  offsetMs: number
  requestedAt: number
  /** confirmed means OBS accepted the queued request, not that the chapter has been verified on disk. */
  status: 'pending' | 'confirmed' | 'unconfirmed' | 'failed'
  error?: string
}

export interface ObsCameraRecordingState {
  ok: boolean
  ready: boolean
  running: boolean
  runId?: string
  startedAt?: number
  cameras: ObsCameraRecordingCamera[]
  marks: ObsCameraRecordingMark[]
  /** CSV editing index with formula-safe cells. */
  indexPath?: string
  /** JSON intent/delivery journal. */
  manifestPath?: string
  error?: string
  lastMarkError?: string
}
