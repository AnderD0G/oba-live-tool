import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

// A separate Windows app profile and file-only Codex credentials; no live account, AI turn or print.
const root = await mkdtemp(path.join(os.tmpdir(), 'oba-install-check-'))
const codexHome = path.join(root, 'codex-home')
const data = path.join(root, 'app-data')
for (const dir of [codexHome, data, path.join(root, 'local')]) await mkdir(dir, { recursive: true })
await writeFile(path.join(codexHome, 'config.toml'), 'cli_auth_credentials_store = "file"\n')
const env = { ...process.env }
for (const name of Object.keys(env)) {
  if (
    [
      'path',
      'appdata',
      'localappdata',
      'electron_run_as_node',
      'codex_home',
      'openai_api_key',
      'codex_api_key',
      'openai_base_url',
      'openai_access_token',
    ].includes(name.toLowerCase())
  )
    delete env[name]
}
Object.assign(env, {
  PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`,
  APPDATA: data,
  LOCALAPPDATA: path.join(root, 'local'),
  CODEX_HOME: codexHome,
})
const executablePath = path.resolve('release/1.6.1-codex.9/win-unpacked/OBA-Codex.exe')
const application = await electron.launch({
  executablePath,
  args: [`--user-data-dir=${path.join(data, 'profile')}`],
  env,
  timeout: 30000,
})
try {
  const page = await application.firstWindow()
  await application.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.hide()
  })
  const failures = []
  page.on('pageerror', error => failures.push(error.message))
  await page.waitForURL(url => url.hash === '#/setup', { timeout: 30000 })
  await page.getByRole('heading', { name: '安装与环境检查' }).waitFor()
  const status = await page.evaluate(() => window.ipcRenderer.invoke('setup:request', 'status'))
  assert.equal(status.ok, true)
  assert.equal(status.status.codex.bundled, true)
  assert.equal(status.status.codex.available, true)
  assert.equal(status.status.codex.loggedIn, false)
  assert.equal(status.status.codex.error, undefined)
  const queue = await page.evaluate(() =>
    window.ipcRenderer.invoke('tickets:request', { action: 'state' }),
  )
  assert.equal(queue.ok, true)
  assert.equal(queue.state.tickets.length, 0)
  assert.equal(queue.state.automatic, null)
  const catcher = await page.evaluate(() =>
    window.ipcRenderer.invoke('catcher:request', { action: 'state', accountId: 'default' }),
  )
  assert.equal(catcher.ok, true)
  assert.equal(catcher.state.active, null)
  assert.deepEqual(failures, [])
  const profile = await application.evaluate(({ app }) => app.getPath('userData'))
  assert.ok(profile.startsWith(root))
  console.log(
    JSON.stringify({
      ok: true,
      version: status.status.version,
      firstRun: 'setup',
      bundledCodex: true,
      loggedIn: false,
      browserDetected: !!status.status.browser,
      printersDetected: status.status.printers.length,
      queueEmpty: true,
      captureOff: true,
      automaticPrintOff: true,
      generatedTokens: 0,
      physicalPrints: 0,
      profile,
    }),
  )
} finally {
  await application.close()
}
