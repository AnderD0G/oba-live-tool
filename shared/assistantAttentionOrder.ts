import type { AssistantDeskRow } from './assistantDesk'

const tierRank = { gold: 0, silver: 1, neutral: 2 }
type AttentionOrderRow = Pick<AssistantDeskRow, 'id' | 'receivedAt' | 'triage'>

/** Manual retention does not change a row's priority or receive time. */
export function compareAssistantAttentionRows(
  a: AttentionOrderRow,
  b: AttentionOrderRow,
  prioritize = true,
) {
  const tier = prioritize
    ? tierRank[a.triage?.tier ?? 'neutral'] - tierRank[b.triage?.tier ?? 'neutral']
    : 0
  return tier || a.receivedAt - b.receivedAt || a.id.localeCompare(b.id)
}
