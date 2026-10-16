import { homedir } from 'node:os'
import path from 'node:path'

/** Explicit profile selection never falls through to another running OBA instance. */
export function userDataCandidates({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (env.OBA_USER_DATA_DIR) return [env.OBA_USER_DATA_DIR]
  const paths = platform === 'win32' ? path.win32 : path.posix
  const appData = platform === 'darwin'
    ? paths.join(home, 'Library', 'Application Support')
    : env.APPDATA || paths.join(home, 'AppData', 'Roaming')
  return [paths.join(appData, 'OBA-Codex'), paths.join(appData, 'oba-live-tool-codex')]
}
