import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CodexAppServer } from '../electron/main/services/CodexAppServer'
import { selectCodex } from '../electron/main/services/CodexRuntime'
import { buildServerArgs } from '../electron/main/services/PersistentCodexDraftService'

const bundle = path.resolve(
  process.argv[2] || 'vendor-build/codex/package/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
)
const dir = await mkdtemp(path.join(os.tmpdir(), 'oba-clean-codex-'))
const home = path.join(dir, 'codex-home')
await mkdir(home)
await writeFile(path.join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n')
const environment = { ...process.env, CODEX_HOME: home }
for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ACCESS_TOKEN'])
  delete environment[key]
const selected = await selectCodex([path.join(dir, 'absent.exe'), bundle], bundle)
assert.equal(selected.bundled, true)
const server = new CodexAppServer({
  executable: selected.path,
  args: buildServerArgs(),
  cwd: dir,
  env: environment,
})
try {
  await server.start()
  const account = await server.request<{ account: unknown }>('account/read', {
    refreshToken: false,
  })
  assert.equal(account.account, null)
  await server.request('config/read', { includeLayers: false, cwd: dir })
  assert.ok(server.pid)
  console.log(
    JSON.stringify({
      ok: true,
      version: selected.version,
      cleanProfile: true,
      loggedIn: false,
      appServer: 'initialized',
      generatedTokens: 0,
    }),
  )
} finally {
  server.dispose()
  await new Promise(resolve => setTimeout(resolve, 500))
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
}
