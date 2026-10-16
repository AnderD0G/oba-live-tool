/** Wall-clock pauses belong to one assistant scene; captured timestamps stay untouched. */
export interface AssistantAttentionPause { startedAt: number; endedAt?: number }

export function assistantAttentionLogicalAt(pauses: readonly AssistantAttentionPause[] | undefined, at: number): number {
  let pausedMs = 0
  for (const pause of pauses ?? []) {
    if (pause.startedAt >= at) break
    pausedMs += Math.max(0, Math.min(at, pause.endedAt ?? at) - pause.startedAt)
  }
  return at - pausedMs
}

/** Earliest wall instant for a logical boundary. Future deadlines use the current pause elapsed so far. */
export function assistantAttentionWallAt(pauses: readonly AssistantAttentionPause[] | undefined, logicalAt: number, now: number): number {
  let pausedMs = 0
  for (const pause of pauses ?? []) {
    if (logicalAt <= pause.startedAt - pausedMs) break
    pausedMs += Math.max(0, (pause.endedAt ?? now) - pause.startedAt)
  }
  return logicalAt + pausedMs
}
