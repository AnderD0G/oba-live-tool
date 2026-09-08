import type { CodexAutoState } from 'shared/codexAutoReply'
import { create } from 'zustand'

export const useCodexAutoStore = create<{
  state: CodexAutoState
  update: (state: CodexAutoState) => void
}>(set => ({
  state: { enabled: false, accountId: null, message: '未开启', records: [] },
  update: state => set({ state }),
}))
