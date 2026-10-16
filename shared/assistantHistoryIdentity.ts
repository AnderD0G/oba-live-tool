/** Query normalization only; never change a captured identity or infer one from a nickname/ID. */
export function normalizeAssistantHistoryHandle(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 201 || /[\u0000-\u001f\u007f]/u.test(value)) return undefined
  const handle = value.trim().replace(/^@/, '').toLowerCase()
  // Default Unicode lowercasing expands İ to i+dot. Validate that exact query
  // representation as its original source unit, without dropping the dot,
  // accepting arbitrary marks, or changing the recorded identity.
  const sourceUnits = handle.replace(/i\u0307/gu, 'İ')
  return sourceUnits.length <= 100 && /^[\p{L}\p{N}_.-]{1,100}$/u.test(sourceUnits) ? handle : undefined
}

export function normalizeAssistantHistoryNickname(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 100 || /[\u0000-\u001f\u007f]/u.test(value)) return undefined
  const nickname = value.trim()
  return nickname || undefined
}
