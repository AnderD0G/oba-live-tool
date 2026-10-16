interface QuitOptions {
  shutdown: () => Promise<void>
  quit: () => void
}

/** Keep the quit barrier independent of analysis storage initialization and Electron. */
export function createAnalysisQuitHandler(options: QuitOptions): (event: { preventDefault(): void }) => void {
  let readyToQuit = false
  let quitting = false
  return event => {
    if (readyToQuit) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    void options.shutdown().catch(() => {}).finally(() => {
      readyToQuit = true
      options.quit()
    })
  }
}
