import type { JsonValue, PayloadLimits, SanitizedPayload } from '../../../../shared/analysisRoom'

const MAX_BYTES = 128 * 1024
const MAX_DEPTH = 16
const encoder = new TextEncoder()
function pointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1')
}
function sensitive(key: string): boolean {
  const normalized = key
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_.-]/g, '')
  return (
    ['__proto__', 'constructor', 'prototype'].includes(key) ||
    /cookie|authorization|password|passwd|secret|credential|token|apikey|headers|url|uri|phone|mobile|email|address|contact|身份证|手机号|手机号码|电话|邮箱|地址|联系方式|口令|密码|凭证|令牌|登录/.test(
      normalized,
    ) ||
    ['session', 'sessionid', 'sessionkey', 'sessionticket', 'authsession'].includes(normalized)
  )
}
/** Count JSON string bytes without allocating an arbitrarily large escaped string. */
function stringBytes(value: string, cap: number): number {
  let bytes = 2
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) bytes += 2
    else if (code < 32) bytes += 6
    else if (code < 128) bytes++
    else if (code < 2048) bytes += 2
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      value.charCodeAt(i + 1) >= 0xdc00 &&
      value.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4
      i++
    } else if (code >= 0xd800 && code <= 0xdfff) bytes += 6
    else bytes += 3
    if (bytes > cap) return cap + 1
  }
  return bytes
}
export function sanitizeBusinessPayload(
  input: unknown,
  overrides?: Partial<PayloadLimits>,
): SanitizedPayload {
  const limits = { maxBytes: MAX_BYTES, maxDepth: MAX_DEPTH, ...overrides }
  if (
    !Number.isSafeInteger(limits.maxBytes) ||
    limits.maxBytes < 256 ||
    limits.maxBytes > MAX_BYTES ||
    !Number.isSafeInteger(limits.maxDepth) ||
    limits.maxDepth < 1 ||
    limits.maxDepth > MAX_DEPTH
  )
    throw new Error('Invalid payload limits')
  const result: SanitizedPayload = {
    data: null,
    complete: true,
    removedPaths: [],
    truncatedPaths: [],
  }
  let used = 100
  let exhausted = false
  const seen = new Set<object>()
  const truncate = (path: string) => {
    result.complete = false
    if (used + stringBytes(path, limits.maxBytes) + 10 < limits.maxBytes) {
      result.truncatedPaths.push(path)
      used += stringBytes(path, limits.maxBytes) + 10
    }
  }
  type Work = { value: unknown; depth: number; path: string; assign: (value: JsonValue) => void }
  const stack: Work[] = [
    {
      value: input,
      depth: 0,
      path: '',
      assign: v => {
        result.data = v
      },
    },
  ]
  while (stack.length && !exhausted) {
    const { value, depth, path, assign } = stack.pop() as Work
    if (depth > limits.maxDepth) {
      truncate(path)
      continue
    }
    if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      typeof value === 'string'
    ) {
      const cost =
        typeof value === 'string'
          ? stringBytes(value, limits.maxBytes - used)
          : JSON.stringify(value).length
      if (used + cost + 32 >= limits.maxBytes) {
        truncate(path)
        exhausted = true
        continue
      }
      used += cost
      assign(value)
      continue
    }
    if (!value || typeof value !== 'object' || seen.has(value)) {
      truncate(path)
      continue
    }
    const proto = Object.getPrototypeOf(value)
    if (!Array.isArray(value) && proto !== null && proto !== Object.prototype) {
      truncate(path)
      continue
    }
    if (Array.isArray(value) && value.length > limits.maxBytes / 2) {
      truncate(path)
      continue
    }
    seen.add(value)
    const output: JsonValue[] | { [key: string]: JsonValue } = Array.isArray(value) ? [] : {}
    assign(output)
    used += 2
    const children: Work[] = []
    let nextArrayIndex = 0
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue
      const keyCost = stringBytes(key, limits.maxBytes - used)
      if (used + keyCost + 64 >= limits.maxBytes) {
        truncate(path)
        exhausted = true
        break
      }
      const childPath = `${path}/${pointer(key)}`
      if (sensitive(key)) {
        const pathCost = stringBytes(childPath, limits.maxBytes - used)
        if (used + pathCost + 32 >= limits.maxBytes) {
          truncate(path)
          exhausted = true
          break
        }
        used += pathCost + 1
        result.removedPaths.push(childPath)
        continue
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) {
        truncate(childPath)
        continue
      }
      if (Array.isArray(value) && key !== String(nextArrayIndex++)) {
        truncate(childPath)
        continue
      }
      used += keyCost + 8
      Object.defineProperty(output, key, {
        value: null,
        writable: true,
        enumerable: true,
        configurable: true,
      })
      children.push({
        value: descriptor.value,
        depth: depth + 1,
        path: childPath,
        assign: v => {
          ;(output as Record<string, JsonValue>)[key] = v
        },
      })
    }
    if (Array.isArray(value) && nextArrayIndex !== value.length) truncate(path)
    if (exhausted) break
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i])
  }
  if (encoder.encode(JSON.stringify(result)).byteLength > limits.maxBytes) {
    return { data: null, complete: false, removedPaths: [], truncatedPaths: [''] }
  }
  return result
}
