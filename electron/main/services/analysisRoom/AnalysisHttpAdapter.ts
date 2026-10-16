import type { IncomingMessage } from 'node:http'
import {
  ANALYSIS_HTTP_ROUTES,
  type AnalysisCommand,
  AnalysisError,
  validateAnalysisCommand,
} from '../../../../shared/analysisRoom'

export function isAnalysisPath(path: string): boolean {
  return (
    path === '/analysis' ||
    path.startsWith('/analysis/') ||
    path === '/interaction/groups' ||
    path.startsWith('/interaction/groups/')
  )
}
function readBody(request: IncomingMessage): Promise<unknown> {
  const max = 4 * 1024 * 1024
  if (!String(request.headers['content-type'] ?? '').includes('application/json'))
    throw new AnalysisError('ANALYSIS_INVALID_INPUT', '请求体必须使用 application/json')
  if (Number(request.headers['content-length']) > max) {
    request.resume()
    throw new AnalysisError('ANALYSIS_LIMIT', '请求体超过 4 MiB')
  }
  return new Promise((resolve, reject) => {
    let settled = false
    let bytes = 0
    const chunks: Buffer[] = []
    const timer = setTimeout(
      () => fail(new AnalysisError('ANALYSIS_INVALID_INPUT', '读取请求体超时')),
      30000,
    )
    const fail = (error: AnalysisError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      chunks.length = 0
      request.resume()
      reject(error)
    }
    request.on('data', (chunk: Buffer) => {
      if (settled) return
      bytes += chunk.length
      if (bytes > max) {
        fail(new AnalysisError('ANALYSIS_LIMIT', '请求体超过 4 MiB'))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new AnalysisError('ANALYSIS_INVALID_INPUT', '请求体不是合法 JSON'))
      }
    })
    request.on('error', () => fail(new AnalysisError('ANALYSIS_INVALID_INPUT', '读取请求体失败')))
    request.on('aborted', () => fail(new AnalysisError('ANALYSIS_INVALID_INPUT', '请求体被中断')))
  })
}
export async function analysisHttpCommand(
  path: string,
  method: string,
  url: URL,
  request: IncomingMessage,
): Promise<AnalysisCommand> {
  const route = ANALYSIS_HTTP_ROUTES.find(route => route.path === path && route.method === method)
  if (!route)
    throw new AnalysisError(
      ANALYSIS_HTTP_ROUTES.some(route => route.path === path)
        ? 'ANALYSIS_METHOD_NOT_ALLOWED'
        : 'ANALYSIS_NOT_FOUND',
      '分析接口或方法不存在',
    )
  let params: unknown
  if (method === 'GET') {
    const query: Record<string, unknown> = {}
    for (const [key, value] of url.searchParams) {
      if (['__proto__', 'constructor', 'prototype'].includes(key) || Object.hasOwn(query, key))
        throw new AnalysisError('ANALYSIS_INVALID_INPUT', '查询字段无效或重复')
      query[key] = key === 'limit' || key === 'version' ? Number(value) : value
    }
    if (['capabilities', 'sessions', 'records', 'fields', 'results'].includes(route.action)) {
      const { accountId, platform, source, ...rest } = query
      params = { scope: { accountId, platform, source }, ...rest }
    } else params = query
  } else {
    if (url.search)
      throw new AnalysisError('ANALYSIS_INVALID_INPUT', '写请求请只在 JSON 中传入参数')
    params = await readBody(request)
  }
  return validateAnalysisCommand({ action: route.action, params })
}
