import type { DirectorRequestRecord } from '../../../shared/director'
import { DirectorRequestHistory } from './DirectorRequestHistory'
import { JsonLedger } from './JsonLedger'

interface MemoryData {
  requests: Record<string, DirectorRequestRecord[]>
  conversations: Record<string, { turns: string[]; updatedAt: number }>
}
export class LiveMemoryStore {
  private ledger: JsonLedger<MemoryData>
  private histories = new Map<string, DirectorRequestHistory>()
  constructor(
    file: string,
    private onRequest?: (account: string, record: DirectorRequestRecord) => void,
  ) {
    this.ledger = new JsonLedger(file, { requests: {}, conversations: {} })
    for (const account of Object.keys(this.ledger.data.requests)) this.requests(account).interrupt()
  }
  requests(account: string) {
    let history = this.histories.get(account)
    if (!history) {
      history = new DirectorRequestHistory(
        this.ledger.data.requests[account] || [],
        records => {
          this.ledger.change(data => {
            data.requests[account] = records
          })
        },
        record => this.onRequest?.(account, record),
      )
      this.histories.set(account, history)
    }
    return history
  }
  recent(account: string, user: string) {
    const entry = this.ledger.data.conversations[JSON.stringify([account, user])]
    // Old dialogue is not a claim about the current live session.
    return entry && Date.now() - entry.updatedAt < 12 * 3600000 ? [...entry.turns] : []
  }
  append(account: string, user: string, turns: string[]) {
    this.remember(account, user, [...this.recent(account, user), ...turns])
  }
  remember(account: string, user: string, turns: string[]) {
    this.ledger.change(data => {
      data.conversations[JSON.stringify([account, user])] = {
        turns: turns.slice(-10),
        updatedAt: Date.now(),
      }
      const keys = Object.keys(data.conversations).sort(
        (a, b) => data.conversations[b].updatedAt - data.conversations[a].updatedAt,
      )
      for (const key of keys.slice(2000)) delete data.conversations[key]
    })
  }
}
