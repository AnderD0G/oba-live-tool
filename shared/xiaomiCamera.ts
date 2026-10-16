export const DEFAULT_XIAOMI_CAMERA_BASE_URL = 'http://192.168.1.5:18765'
export const XIAOMI_PREVIEW_MAX_AGE_MS = 2000

export type XiaomiCameraState = 'off' | 'ready' | 'capturing' | 'offline' | 'unknown'
export interface XiaomiCameraStatus {
  state: XiaomiCameraState
  timestamp: string
  error?: string
}
export interface XiaomiCameraSettings {
  available: boolean
  ready?: boolean
  zoom?: number
  zoom_min?: number
  zoom_max?: number
  observed_zoom?: number | null
  saved_zoom?: number
  focus_supported?: boolean
  focus_mode?: string
  observed_focus_mode?: string | null
  focus_state?: string
  focus_pending?: boolean
  last_focus_result?: string
  last_control_error?: string | null
  timestamp_ms?: number
  error?: string
}
export interface XiaomiCameraOperation {
  success: boolean
  changed?: boolean
  applied?: boolean
  saved?: boolean
  focus_submitted?: boolean
}
export interface XiaomiCameraPreview {
  id: string
  dataUrl: string
  capturedAt: number
  expiresAt: number
}
export interface XiaomiCameraPublicConfig {
  baseUrl: string
  hasToken: boolean
}
export type XiaomiCameraCommand =
  | { action: 'config-get' }
  | { action: 'config-save'; config: { baseUrl: string; token?: string } }
  | { action: 'status' | 'settings' | 'start' | 'stop' | 'autofocus' | 'preview' }
  | { action: 'preview-cancel' }
  | { action: 'zoom'; ratio: number }
  | { action: 'focus'; x: number; y: number; previewId: string }
export interface XiaomiCameraResult {
  ok: boolean
  error?: { code: string; message: string; outcomeUnknown?: boolean }
  message?: string
  config?: XiaomiCameraPublicConfig
  camera?: XiaomiCameraStatus
  settings?: XiaomiCameraSettings
  operation?: XiaomiCameraOperation
  preview?: XiaomiCameraPreview
}

export const xiaomiCameraStateLabels: Record<XiaomiCameraState, string> = {
  off: '已核验关闭',
  ready: '已就绪，等待视频消费者',
  capturing: '已连接视频消费者',
  offline: '手机离线，无法确认相机状态',
  unknown: '相机状态未知',
}

export function xiaomiPreviewFocusPoint(
  point: { x: number; y: number },
  image: {
    left: number
    top: number
    width: number
    height: number
    naturalWidth: number
    naturalHeight: number
  },
): { x: number; y: number } | null {
  if (
    !Object.values({ ...image, ...point }).every(Number.isFinite) ||
    Math.min(image.width, image.height, image.naturalWidth, image.naturalHeight) <= 0
  )
    return null
  const scale = Math.min(image.width / image.naturalWidth, image.height / image.naturalHeight)
  const width = image.naturalWidth * scale
  const height = image.naturalHeight * scale
  const left = image.left + (image.width - width) / 2
  const top = image.top + (image.height - height) / 2
  const x = (point.x - left) / width
  const y = (point.y - top) / height
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null
}
