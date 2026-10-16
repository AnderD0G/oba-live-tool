/** Release steps may fail independently; retry the unfinished step without repeating completed work. */
export function releaseAssistantCapture(
  releaseListener: () => Promise<void>,
  stopCapture?: () => Promise<void>,
) {
  let listenerReleased = false
  let captureStopped = !stopCapture
  let inFlight: Promise<void> | undefined
  return () => {
    if (listenerReleased && captureStopped) return Promise.resolve()
    if (inFlight) return inFlight
    const work = (async () => {
      if (!listenerReleased) {
        await releaseListener()
        listenerReleased = true
      }
      if (!captureStopped) {
        await stopCapture?.()
        captureStopped = true
      }
    })()
    inFlight = work
    void work
      .finally(() => {
        inFlight = undefined
      })
      .catch(() => {})
    return work
  }
}
