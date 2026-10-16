// Operator-authorized acceptance against real OBS. Never streams or starts platform collection.
// node scripts/smoke-desktop-camera-recording.mjs [--preview-only] ABS_EXECUTABLE ABS_PROFILE ABS_RECEIPT_DIRECTORY
// --preview-only checks local drafts and DOM stability with OBS disconnected; no live credentials are copied.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron } from 'playwright'

const args = process.argv.slice(2)
const previewOnly = args.includes('--preview-only')
assert.ok(args.filter(value => value === '--preview-only').length <= 1)
const paths = args.filter(value => value !== '--preview-only')
assert.equal(paths.length, 3)
assert.ok(paths.every(isAbsolute))
const [executablePath, sourceProfile, receiptDirectory] = await Promise.all(
  paths.map(value => realpath(value)),
)
const profile = await mkdtemp(join(tmpdir(), 'oba-camera-recording-smoke-'))
await chmod(profile, 0o700)
const environment = { ...process.env, OBA_USER_DATA_DIR: profile, OBA_DIRECTOR_API_PORT: '0' }
for (const name of [
  'ELECTRON_RUN_AS_NODE',
  'VITE_DEV_SERVER_URL',
  'OBA_DEBUG_PORT',
  'OBA_DIRECTOR_API_URL',
  'OBA_DIRECTOR_API_TOKEN',
])
  delete environment[name]
let application
let page
let runId
let startAdmitted = false
let originalCamera
let mobileStarted = false
const invoke = command =>
  page.evaluate(command => window.ipcRenderer.invoke('obsEffect:request', command), command)
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
async function checked(command) {
  const result = await invoke(command)
  assert.equal(result.ok, true, result.error || `Failed ${command.action}`)
  return result
}
async function readUntil(predicate) {
  const until = Date.now() + 20_000
  let state
  while (Date.now() < until) {
    state = (await checked({ action: 'camera-recording-status' })).recording
    if (startAdmitted && state.runId) runId = state.runId
    if (predicate(state)) return state
    await pause(150)
  }
  assert.fail(`Recording state did not settle: ${JSON.stringify(state)}`)
}
async function stableComposer() {
  await page.getByRole('heading', { name: '助播台', exact: true }).waitFor()
  const workspace = page.locator('main.assistant-desk')
  await workspace.getByRole('region', { name: '历史与片段复盘', exact: true }).waitFor()
  const composer = workspace.locator(':scope > details[aria-label="自由发言"]')
  // State is polled every two seconds. Observe more than two intervals so a
  // duplicate sibling key cannot leave orphaned composers after reconciliation.
  const until = Date.now() + 4500
  do {
    assert.equal(await workspace.count(), 1, 'Assistant desk must have exactly one mounted workspace')
    assert.equal(await composer.count(), 1, 'State polling must preserve exactly one freeform composer')
    assert.equal(await composer.locator(':scope > summary').count(), 1, 'Composer must have exactly one direct summary')
    await pause(150)
  } while (Date.now() < until)
  return composer
}
try {
  if (previewOnly) {
    // An empty profile would fall back to the live OBS port 4455. Override it
    // explicitly instead, including during background UI initialization.
    await writeFile(join(profile, 'obs-enter-effect.json'), JSON.stringify({
      enabled: false, url: 'ws://127.0.0.1:1', password: '', sceneName: '', sourceName: '',
      durationMs: 3000, minFansLevel: 0, effects: [],
    }), { mode: 0o600 })
  } else {
    for (const name of ['obs-enter-effect.json', 'obs-camera.json'])
      await writeFile(join(profile, name), await readFile(join(sourceProfile, name)), { mode: 0o600 })
  }
  application = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${profile}`],
    env: environment,
    timeout: 60000,
  })
  const appInfo = await application.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    directory: app.getPath('userData'),
  }))
  assert.equal(await realpath(appInfo.directory), await realpath(profile))
  assert.equal(appInfo.packaged, true)
  page = await application.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => !!window.ipcRenderer?.invoke)
  const composer = await stableComposer()
  await composer.locator(':scope > summary').click()
  await composer.getByRole('textbox', { name: '自由发言中文草稿' }).fill('自由发言本地预览：正在补货，请稍等。')
  await composer.getByRole('textbox', { name: '自由发言发送预览' }).waitFor()
  let broadcast
  for (let index = 0; index < 40; index++) {
    broadcast = await page.evaluate(() => window.ipcRenderer.invoke('assistant-broadcast:request', { action: 'state', accountId: 'default' }))
    if (broadcast.ok && broadcast.data.chinese === '自由发言本地预览：正在补货，请稍等。') break
    await pause(100)
  }
  assert.equal(broadcast.ok, true)
  assert.equal(broadcast.data.finalText, '自由发言本地预览：正在补货，请稍等。')
  assert.equal(broadcast.data.delivery.status, 'idle')
  assert.equal(broadcast.data.useOriginal, true)
  await page.evaluate(command => window.ipcRenderer.invoke('assistant-broadcast:request', command), { action: 'clear', accountId: 'default', draftId: broadcast.data.draftId, expectedRevision: broadcast.data.revision })
  if (previewOnly) {
    const receipt = { ok: true, previewOnly: true, ...appInfo, directory: undefined,
      freeformDraftPreview: true, freeformSendClicked: false, uniqueComposerAcrossStatePolling: true,
      obsConnection: 'disabled', obsCredentialsCopied: false, realRecordingStarted: false,
      cameraSwitched: false, microphoneControlRequested: false, realPlatformCaptureStarted: false, publicSends: false }
    await writeFile(join(receiptDirectory, 'product-preview-acceptance.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 })
    console.log(JSON.stringify(receipt))
  } else {
  const camera = await checked({ action: 'camera-status' })
  originalCamera = camera.cameraStatus.selected
  assert.ok(['iphone', 'android'].includes(originalCamera))
  const initial = await readUntil(state => state.ready)
  assert.equal(initial.running, false)
  assert.ok(initial.cameras.every(camera => !camera.active))
  const controls = page.getByRole('region', { name: '双路独立录像', exact: true })
  await controls.waitFor()
  await controls.getByRole('button', { name: '开始两路录像', exact: true }).click()
  startAdmitted = true
  let state = await readUntil(
    state =>
      state.running &&
      state.cameras.length === 2 &&
      state.cameras.every(camera => camera.active && camera.owned),
  )
  runId = state.runId
  assert.ok(runId)
  const marks = []
  for (const [target, label] of [
    ['iphone', '补货'],
    ['android', '观众问题'],
    ['iphone', '回到 iPhone'],
  ]) {
    await page
      .getByRole('button', { name: target === 'iphone' ? 'iPhone' : '小米4K', exact: true })
      .click()
    const selected = await checked({ action: 'camera-status' })
    assert.equal(selected.cameraStatus.selected, target)
    await pause(1600)
    await controls.getByRole('textbox', { name: '章节标题', exact: true }).fill(label)
    await controls.getByRole('button', { name: '打点当前机位', exact: true }).click()
    state = await readUntil(state =>
      state.marks.some(mark => mark.label === label && mark.status === 'confirmed'),
    )
    const mark = state.marks.find(mark => mark.label === label)
    assert.equal(mark.target, target)
    assert.ok(state.cameras.every(camera => camera.active && camera.owned))
    marks.push(mark)
  }
  // The original marker interface now adds a chapter, even without a live capture session.
  const legacyResult = await page.evaluate(
    command => window.ipcRenderer.invoke('assistant-desk:request', command),
    {
      action: 'segment-toggle',
      params: { accountId: 'default', runId, requestId: crypto.randomUUID(), label: '原打点接口' },
    },
  )
  assert.equal(legacyResult.ok, true, legacyResult.error?.message)
  marks.push(legacyResult.data.marks.find(mark => mark.label === '原打点接口'))
  assert.equal(marks.at(-1).target, 'iphone')
  const staleRange = await page.evaluate(
    command => window.ipcRenderer.invoke('assistant-desk:request', command),
    {
      action: 'segment-toggle',
      params: {
        accountId: 'default',
        sessionId: 'old-capture',
        expectedOpenSegmentId: null,
        requestId: crypto.randomUUID(),
      },
    },
  )
  assert.equal(staleRange.ok, false)
  assert.match(staleRange.error.message, /录像章节|片段起止/)
  // The authenticated phone observes the same run and may add one explicit point without collection.
  const access = await page.evaluate(() =>
    window.ipcRenderer.invoke('assistant-mobile:request', {
      action: 'start',
      accountId: 'default',
    }),
  )
  assert.equal(access.ok, true)
  mobileStarted = true
  const mobileUrl = access.data.urls[0]
  const phone = async command => {
    const response = await fetch(new URL('api/camera-recording', mobileUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    })
    return { status: response.status, body: await response.json() }
  }
  const phoneState = await phone({ action: 'status' })
  assert.equal(phoneState.status, 200)
  assert.equal(phoneState.body.ok, true)
  const phoneRun = phoneState.body.data ?? phoneState.body.recording
  assert.equal(phoneRun.runId, runId)
  const phoneMark = await phone({
    action: 'mark',
    runId,
    requestId: crypto.randomUUID(),
    label: '手机补货提醒',
  })
  assert.equal(phoneMark.status, 200)
  assert.equal(phoneMark.body.ok, true)
  state = await readUntil(state =>
    state.marks.some(mark => mark.label === '手机补货提醒' && mark.status === 'confirmed'),
  )
  marks.push(state.marks.find(mark => mark.label === '手机补货提醒'))
  assert.equal(marks.at(-1).target, 'iphone')
  const forbiddenStart = await phone({ action: 'start', requestId: crypto.randomUUID() })
  assert.equal(forbiddenStart.status, 400)
  await controls.getByRole('button', { name: '停止两路录像', exact: true }).click()
  state = await readUntil(state => !state.running && state.cameras.every(camera => !camera.active))
  startAdmitted = false
  runId = undefined
  const probes = []
  const run = promisify(execFile)
  for (const camera of state.cameras) {
    assert.ok(isAbsolute(camera.outputPath))
    const result = await run(
      '/opt/homebrew/bin/ffprobe',
      [
        '-v',
        'error',
        '-show_format',
        '-show_streams',
        '-show_chapters',
        '-of',
        'json',
        camera.outputPath,
      ],
      { maxBuffer: 2 * 1024 * 1024 },
    )
    const probe = JSON.parse(result.stdout)
    const titles = probe.chapters.map(chapter => chapter.tags?.title)
    const ownMarks = marks.filter(mark => mark.target === camera.target)
    const otherMarks = marks.filter(mark => mark.target !== camera.target)
    for (const mark of ownMarks) {
      assert.ok(titles.includes(mark.chapterName), `Missing chapter for ${mark.label}`)
      const chapter = probe.chapters.find(chapter => chapter.tags?.title === mark.chapterName)
      assert.ok(
        Math.abs(Number(chapter.start_time) * 1000 - mark.offsetMs) < 1000,
        'Chapter must be near the observed output timestamp',
      )
    }
    for (const mark of otherMarks)
      assert.ok(
        !titles.includes(mark.chapterName),
        'A point must not leak into the other camera file',
      )
    assert.ok(Number(probe.format.duration) >= 5)
    probes.push({ target: camera.target, path: camera.outputPath, probe })
  }
  for (const name of ['manifestPath', 'indexPath'])
    if (state[name])
      await writeFile(
        join(
          receiptDirectory,
          name === 'manifestPath'
            ? 'product-recording-manifest.json'
            : 'product-recording-index.csv',
        ),
        await readFile(state[name]),
        { mode: 0o600 },
      )
  const receipt = {
    ok: true,
    ...appInfo,
    directory: undefined,
    packagedDesktopButtons: true,
    freeformDraftPreview: true,
    freeformSendClicked: false,
    existingMarkerInterfaceReplaced: true,
    staleRangeRejected: true,
    authenticatedPhoneMark: true,
    forbiddenPhoneStart: true,
    realCameraFiles: true,
    realPlatformCaptureStarted: false,
    publicSends: false,
    marks,
    probes,
  }
  await writeFile(
    join(receiptDirectory, 'product-recording-acceptance.json'),
    JSON.stringify(receipt, null, 2),
    { mode: 0o600 },
  )
  console.log(
    JSON.stringify({
      ok: true,
      version: appInfo.version,
      desktopButtons: true,
      phoneMark: true,
      markers: marks.map(mark => ({
        target: mark.target,
        label: mark.label,
        offsetMs: mark.offsetMs,
      })),
      files: probes.map(item => ({
        target: item.target,
        path: item.path,
        chapters: item.probe.chapters.length,
      })),
    }),
  )
  }
} finally {
  if (!previewOnly && runId && page)
    await invoke({ action: 'camera-recording-stop', runId, requestId: crypto.randomUUID() }).catch(
      () => {},
    )
  if (!previewOnly && page && originalCamera)
    await invoke({ action: 'camera-switch', target: originalCamera }).catch(() => {})
  if (!previewOnly && page && mobileStarted)
    await page
      .evaluate(() =>
        window.ipcRenderer.invoke('assistant-mobile:request', {
          action: 'stop',
          accountId: 'default',
        }),
      )
      .catch(() => {})
  if (application) await application.close()
  const child = relative(resolve(tmpdir()), resolve(profile))
  assert.ok(
    child.startsWith('oba-camera-recording-smoke-') && !child.includes('..') && !isAbsolute(child),
  )
  await rm(profile, { recursive: true, force: true })
}
