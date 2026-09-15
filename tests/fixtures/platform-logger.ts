// Connection tests must not start Electron logging or emit live-comment receipts.
export function createLogger() {
  throw new Error('Unexpected live logger call in isolated connection test')
}
