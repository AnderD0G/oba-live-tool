// Read-only acceptance against the packaged app and the operator's running services.
// Usage: node scripts/smoke-desktop-live-controls.mjs ABS_EXECUTABLE ABS_CONFIG_PROFILE
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { _electron as electron } from 'playwright'

assert.ok(process.argv.length === 4 && process.argv.slice(2).every(isAbsolute), 'Supply absolute executable and configuration profile paths')
const executablePath = await realpath(process.argv[2])
const sourceProfile = await realpath(process.argv[3])
const profile = await mkdtemp(join(tmpdir(), 'oba-live-controls-smoke-'))
await chmod(profile, 0o700)
const secrets = []
const environment = { ...process.env, OBA_USER_DATA_DIR: profile, OBA_DIRECTOR_API_PORT: '0' }
for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'OBA_DEBUG_PORT', 'OBA_DIRECTOR_API_URL', 'OBA_DIRECTOR_API_TOKEN']) delete environment[key]
let application
let page
let mobileStarted = false
try {
  // Copy only the private connection settings. No credentials, histories or capture sessions.
  const effect = JSON.parse(await readFile(join(sourceProfile, 'obs-enter-effect.json'), 'utf8'))
  const xiaomi = JSON.parse(await readFile(join(sourceProfile, 'private', 'xiaomi-camera.json'), 'utf8'))
  assert.equal(typeof effect.password, 'string')
  assert.equal(typeof xiaomi.token, 'string')
  secrets.push(effect.password, xiaomi.token)
  await mkdir(join(profile, 'private'), { mode: 0o700 })
  for (const [name, content] of [
    ['obs-enter-effect.json', JSON.stringify({ ...effect, enabled: false })],
    ['obs-camera.json', await readFile(join(sourceProfile, 'obs-camera.json'), 'utf8')],
    ['private/xiaomi-camera.json', JSON.stringify(xiaomi)],
  ]) await writeFile(join(profile, name), content, { mode: 0o600 })
  application = await electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], env: environment, timeout: 60000 })
  const info = await application.evaluate(({ app }) => ({ profile: app.getPath('userData'), packaged: app.isPackaged, version: app.getVersion() }))
  assert.equal(await realpath(info.profile), await realpath(profile))
  assert.equal(info.packaged, true)
  page = await application.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => typeof window.ipcRenderer?.invoke === 'function')
  await page.getByRole('heading', { name: '助播台', exact: true }).waitFor()
  const invoke = (channel, command) => page.evaluate(([channel, command]) => window.ipcRenderer.invoke(channel, command), [channel, command])
  const mic = await invoke('studio-mic-hotkey:request', { action: 'status' })
  assert.equal(mic.ok, true)
  assert.equal(mic.data.backend, 'api')
  assert.ok(['muted', 'unmuted'].includes(mic.data.micState))
  const camera = await invoke('obsEffect:request', { action: 'camera-status' })
  assert.equal(camera.ok, true)
  assert.equal(camera.cameraStatus.ok, true)
  assert.ok(['android', 'iphone'].includes(camera.cameraStatus.selected))
  const xiaomiStatus = await invoke('xiaomi-camera:request', { action: 'status' })
  assert.equal(xiaomiStatus.ok, true)
  assert.ok(['off', 'ready', 'capturing', 'offline', 'unknown'].includes(xiaomiStatus.camera.state))
  await page.getByRole('region', { name: '直播与豆包讲话切换' }).waitFor()
  assert.equal(await page.getByRole('button', { name: '授权热键控制', exact: true }).count(), 0)
  const zoomSlider = page.getByRole('slider', { name: '连续变焦倍率', exact: true })
  await zoomSlider.waitFor()
  assert.equal(await zoomSlider.getAttribute('step'), '0.01')
  assert.equal((await invoke('xiaomi-camera:request', { action: 'preview-cancel' })).ok, true)
  const openPreview = page.getByRole('button', { name: '打开操作预览', exact: true })
  await openPreview.click()
  await page.getByText(/小型竖屏预览，目标 30 帧\/秒/).waitFor()
  await page.getByRole('button', { name: '关闭操作预览', exact: true }).click()
  await openPreview.waitFor()
  assert.equal(await page.getByRole('img', { name: '小米相机竖屏操作预览', exact: true }).count(), 0)
  const access = await invoke('assistant-mobile:request', { action: 'start', accountId: 'default' })
  assert.equal(access.ok, true)
  mobileStarted = true
  assert.equal(access.data.active, true)
  assert.ok(access.data.urls.length > 0)
  const base = access.data.urls[0]
  const request = async (route, command) => {
    const response = await fetch(new URL(route, base), {
      ...(command ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(15000),
    })
    assert.equal(response.status, 200, `Mobile ${route} must succeed`)
    return response.text()
  }
  assert.ok((await request('')).includes('app.js'))
  const phoneScript = await request('app.js')
  assert.ok(phoneScript.includes('DeepSeek'))
  assert.ok(phoneScript.includes('目标 30 帧/秒') && phoneScript.includes('开启预览'))
  const phonePayloads = []
  for (const route of ['api/camera', 'api/studio-mic', 'api/xiaomi']) {
    const raw = await request(route, { action: 'status' })
    phonePayloads.push(raw)
    const result = JSON.parse(raw)
    assert.equal(result.ok, true)
    if (route === 'api/studio-mic') {
      assert.equal(result.data.backend, 'api')
      assert.equal(result.data.micState, mic.data.micState)
    }
  }
  for (const secret of secrets.filter(Boolean))
    assert.ok(phonePayloads.every(payload => !payload.includes(secret)), 'Phone responses must not contain connection secrets')
  const state = await invoke('assistant-desk:request', { action: 'state', params: { accountId: 'default' } })
  assert.equal(state.ok, true)
  assert.equal(state.data.activeSession, undefined)
  console.log(JSON.stringify({ ok: true, packaged: true, version: info.version, desktopIpc: ['obs-camera', 'xiaomi-camera', 'studio-mic-api'], xiaomiState: xiaomiStatus.camera.state, authenticatedPhoneRoutes: true, phoneAssets: true, phoneSecretsExcluded: true, nativePermissionPromptRemoved: true, fractionalZoomSlider: true, onDemand30FpsPreviewControls: true, previewCancelIpc: true, writesToLiveServices: false, captureStarted: false }))
} finally {
  if (mobileStarted && page) await page.evaluate(() => window.ipcRenderer.invoke('assistant-mobile:request', { action: 'stop', accountId: 'default' })).catch(() => {})
  if (application) await application.close()
  const cleanupTarget = relative(resolve(tmpdir()), resolve(profile))
  assert.ok(cleanupTarget.startsWith('oba-live-controls-smoke-') && !cleanupTarget.includes('..') && !isAbsolute(cleanupTarget))
  await rm(profile, { recursive: true, force: true })
}
