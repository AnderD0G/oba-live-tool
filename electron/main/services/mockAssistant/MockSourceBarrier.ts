const transitions = new Map<string, Promise<unknown>>()
/** Capture admission and source selection share the same per-account boundary. */
export async function withAssistantSourceTransition<T>(
  accountId: string,
  work: () => Promise<T>,
): Promise<T> {
  const task = (transitions.get(accountId) ?? Promise.resolve()).catch(() => {}).then(work)
  transitions.set(accountId, task)
  try {
    return await task
  } finally {
    if (transitions.get(accountId) === task) transitions.delete(accountId)
  }
}
