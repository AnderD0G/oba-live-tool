import { randomUUID } from 'node:crypto'
import {
  AnalysisError,
  type AnalysisErrorCode,
  type AnalysisResponse,
} from '../../../../shared/analysisRoom'

const codes: Record<AnalysisErrorCode, number> = {
  ANALYSIS_INVALID_INPUT: 400,
  ANALYSIS_UNAUTHENTICATED: 401,
  ANALYSIS_NOT_CONNECTED: 409,
  ANALYSIS_SOURCE_UNSUPPORTED: 409,
  ANALYSIS_SOURCE_CONFLICT: 409,
  ANALYSIS_NOT_FOUND: 404,
  ANALYSIS_INCOMPLETE: 409,
  ANALYSIS_STORAGE_FAILED: 507,
  ANALYSIS_LIMIT: 413,
  ANALYSIS_REQUEST_CONFLICT: 409,
  ANALYSIS_UNAVAILABLE: 503,
  ANALYSIS_METHOD_NOT_ALLOWED: 405,
  ANALYSIS_INTERNAL: 500,
  MAPPING_INVALID: 400,
  MAPPING_REVISION_CONFLICT: 409,
  MAPPING_PREVIEW_STALE: 409,
  MAPPING_GROUP_DEPENDENCY: 409,
  GROUP_INVALID: 400,
  GROUP_REVISION_CONFLICT: 409,
  GROUP_PREVIEW_STALE: 409,
}
export function analysisFailure(error: unknown, traceId = randomUUID()): AnalysisResponse<never> {
  const known = error instanceof AnalysisError && Object.hasOwn(codes, error.code)
  return {
    ok: false,
    error: {
      code: known ? error.code : 'ANALYSIS_INTERNAL',
      message: known
        ? error.message.slice(0, 512)
        : '分析服务暂时无法完成请求，请按 traceId 检查内部审计',
      retryable: known ? error.retryable : false,
    },
    traceId,
  }
}
export function analysisHttpStatus(response: AnalysisResponse): number {
  return response.ok ? 200 : (codes[response.error.code] ?? 500)
}
