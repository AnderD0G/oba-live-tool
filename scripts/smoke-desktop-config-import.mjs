// Real installed-Electron verification. Only closes the child launched here.
// Usage: node scripts/smoke-desktop-config-import.mjs ABSOLUTE_EXECUTABLE
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { _electron as electron } from 'playwright'

assert.ok(process.argv.length === 3 && isAbsolute(process.argv[2]), 'Supply the absolute installed executable path')
const executablePath = await realpath(process.argv[2])
const profile = await mkdtemp(join(tmpdir(), 'oba-desktop-import-smoke-'))
const environment = { ...process.env, OBA_USER_DATA_DIR: profile, OBA_DIRECTOR_API_PORT: '0' }
for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'OBA_DEBUG_PORT', 'OBA_DIRECTOR_API_URL', 'OBA_DIRECTOR_API_TOKEN']) delete environment[key]
let application
try {
  application = await electron.launch({ executablePath, args: [...(process.platform === 'darwin' ? [] : ['--assistant-desk']), `--user-data-dir=${profile}`], env: environment, timeout: 60000 })
  const info = await application.evaluate(({ app }) => ({ profile: app.getPath('userData'), packaged: app.isPackaged, version: app.getVersion(), executable: process.execPath }))
  assert.equal(await realpath(info.profile), await realpath(profile))
  assert.equal(await realpath(info.executable), executablePath)
  assert.equal(info.packaged, true)
  const page = await application.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => typeof window.ipcRenderer?.invoke === 'function')
  await page.getByRole('heading', { name: '助播台', exact: true }).waitFor()
  for (const name of ['实时助播台', 'OBS 设置', '应用设置', '自动分析室'])
    await page.getByRole('link', { name: new RegExp(`${name}$`) }).waitFor()
  await page.getByRole('button', { name: '开启手机入口', exact: true }).waitFor()
  const state = async () => {
    const result = await page.evaluate(() => window.ipcRenderer.invoke('assistant-desk:request', { action: 'state', params: { accountId: 'default' } }))
    assert.equal(result.ok, true)
    return result.data
  }
  const before = await state()
  assert.equal(before.activeSession, undefined); assert.equal(before.rows.length, 0); assert.equal(before.sessions.length, 0)
  const endpointFile = join(profile, 'director-api.json')
  let endpointBefore
  for (const deadline = Date.now() + 10000; !endpointBefore && Date.now() < deadline;) {
    try { endpointBefore = await readFile(endpointFile, 'utf8') }
    catch { await new Promise(resolve => setTimeout(resolve, 100)) }
  }
  assert.ok(endpointBefore, 'Installed desktop API must be ready')
  const configuration = { format: 'oba-assistant-config', version: 1, accountId: 'default',
    context: { ...before.context, revision: 900, knowledge: 'PRIVATE installed desktop knowledge', instructions: 'PRIVATE installed desktop instructions', replyMode: 'auto' },
    audiencePolicy: { ...before.audiencePolicy, revision: 800 },
    replyPolicy: { revision: 700, enabled: true, rules: [{ id: 'comment', enabled: true, action: 'comment', mode: 'auto', priority: 100, knowledge: 'PRIVATE installed action knowledge', instructions: 'PRIVATE installed action instructions' }] } }
  const source = join(profile, 'private-import.json'), credentials = join(profile, 'credential-preservation.fixture')
  await writeFile(source, JSON.stringify(configuration)); await writeFile(credentials, 'PRIVATE credential sentinel')
  const result = await promisify(execFile)(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'import-desktop-assistant-config.mjs'), source, profile], { windowsHide: true, timeout: 30000 })
  const receipt = JSON.parse(result.stdout)
  assert.equal(receipt.imported, true); assert.equal(receipt.applied.length, 3)
  assert.equal(receipt.credentialsImported, false); assert.equal(receipt.audienceRecordsImported, 0)
  assert.ok(!result.stdout.includes('PRIVATE')); assert.ok(!result.stderr.includes('PRIVATE'))
  assert.ok(!result.stdout.includes(JSON.parse(endpointBefore).token))
  const after = await state()
  assert.equal(after.context.revision, before.context.revision + 1)
  assert.equal(after.audiencePolicy.revision, before.audiencePolicy.revision + 1)
  assert.equal(after.replyPolicy.revision, before.replyPolicy.revision + 1)
  assert.equal(after.context.knowledge, configuration.context.knowledge)
  assert.equal(after.context.instructions, configuration.context.instructions)
  assert.equal(after.context.replyMode, 'auto')
  assert.equal(after.replyPolicy.rules[0].knowledge, configuration.replyPolicy.rules[0].knowledge)
  assert.equal(after.activeSession, undefined); assert.equal(after.rows.length, 0); assert.equal(after.sessions.length, 0)
  assert.equal(await readFile(credentials, 'utf8'), 'PRIVATE credential sentinel')
  assert.equal(await readFile(endpointFile, 'utf8'), endpointBefore)
  console.log(JSON.stringify({ ok: true, packaged: info.packaged, version: info.version, actualUserDataVerified: true, completeDesktopUi: true, desktopApiImported: true, realIpcReadback: true,
    revisions: receipt.applied, credentialsPreserved: true, captureStarted: false, audienceRecordsImported: 0 }))
} finally {
  if (application) await application.close()
  // This path is allocated by mkdtemp in this process, never supplied by the operator.
  const cleanupTarget = relative(resolve(tmpdir()), resolve(profile))
  assert.ok(cleanupTarget.startsWith('oba-desktop-import-smoke-') && !cleanupTarget.includes('..') && !isAbsolute(cleanupTarget))
  await rm(profile, { recursive: true, force: true })
}
