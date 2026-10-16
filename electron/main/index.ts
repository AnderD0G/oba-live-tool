import { mkdirSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { app } from 'electron'

// Isolated release smoke tests must not read or mutate the operator's live profile.
if (process.env.OBA_USER_DATA_DIR) {
  if (!isAbsolute(process.env.OBA_USER_DATA_DIR))
    throw new Error('OBA_USER_DATA_DIR must be absolute')
  mkdirSync(process.env.OBA_USER_DATA_DIR, { recursive: true })
  app.setPath('userData', process.env.OBA_USER_DATA_DIR)
}

if (typeof process.setSourceMapsEnabled === 'function') process.setSourceMapsEnabled(true)
import('./app')
