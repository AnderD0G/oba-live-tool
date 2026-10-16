import { useAccounts } from '@/hooks/useAccounts'
import { useAssistantDesk } from '@/hooks/useAssistantDesk'
import { AssistantDeskView } from './AssistantDeskView'
import './style.css'
import './mobileAccess.css'

export default function AssistantDesk() {
  const accountId = useAccounts(state => state.currentAccountId)
  const accountName = useAccounts(
    state => state.accounts.find(account => account.id === accountId)?.name ?? accountId,
  )
  const controller = useAssistantDesk(accountId)
  return <AssistantDeskView key={accountId} controller={controller} accountName={accountName} />
}
