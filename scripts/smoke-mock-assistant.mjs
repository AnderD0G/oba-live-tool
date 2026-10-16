// Packaged acceptance in a fresh owned profile. Never launches capture, models, OBS or a platform send.
// Usage: node scripts/smoke-mock-assistant.mjs ABSOLUTE_CANDIDATE_EXECUTABLE
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

export function buildSmokeBatch(metadata, marker) {
  assert.equal(metadata.accountId, 'default')
  assert.match(metadata.metadataRevision, /^[a-f0-9]{64}$/)
  assert.ok(metadata.catalog.countries.some(country => country.code === 'TH'))
  return {
    version: 1,
    accountId: metadata.accountId,
    metadataRevision: metadata.metadataRevision,
    batchId: `smoke-${randomUUID()}`,
    name: 'Owned packaged acceptance',
    durationMs: 300,
    users: [
      {
        id: 'thai',
        nickname: `${marker}_VIEWER`,
        payLevel: 25,
        fansClubLevel: 3,
        followerCount: 307,
        manualCountry: 'TH',
      },
      { id: 'unknown', nickname: `${marker}_UNKNOWN` },
    ],
    events: [
      { id: 'enter', userId: 'thai', atMs: 0, kind: 'enter' },
      {
        id: 'comment',
        userId: 'thai',
        atMs: 30,
        kind: 'comment',
        text: `${marker}_TEXT ราคาเท่าไหร่?`,
      },
      { id: 'like', userId: 'thai', atMs: 60, kind: 'like', likeCount: 2 },
      { id: 'follow', userId: 'thai', atMs: 90, kind: 'follow' },
      {
        id: 'gift',
        userId: 'thai',
        atMs: 120,
        kind: 'gift',
        gift: { id: 'rose', groupId: 'one', count: 3, final: true, unitCoins: 1, totalCoins: 3 },
      },
      {
        id: 'unknown-comment',
        userId: 'unknown',
        atMs: 150,
        kind: 'comment',
        text: `${marker}_UNKNOWN_TEXT hello`,
      },
      { id: 'event', userId: 'unknown', atMs: 180, kind: 'event', text: `${marker}_EVENT` },
      { id: 'leave', userId: 'thai', atMs: 210, kind: 'leave' },
    ],
  }
}

/** Inspect formal JSON/SQLite facts, including logical values that could span SQLite pages. */
export async function scanFormalStorage(profile, markers) {
  const files = []
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && /\.(?:jsonl?|sqlite(?:-wal|-shm)?)$/.test(entry.name))
        files.push(path)
    }
  }
  await walk(profile)
  let sqliteFiles = 0
  const contains = value =>
    markers.some(marker => typeof value === 'string' && value.includes(marker))
  for (const path of files) {
    const bytes = await readFile(path)
    assert.ok(
      !markers.some(
        marker =>
          bytes.includes(Buffer.from(marker)) || bytes.includes(Buffer.from(marker, 'utf16le')),
      ),
      'Mock marker found in formal storage',
    )
    if (!path.endsWith('.sqlite')) continue
    sqliteFiles++
    const database = new DatabaseSync(path, { readOnly: true })
    try {
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all()
      for (const { name } of tables) {
        const statement = database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
        for (const row of statement.iterate())
          assert.ok(!Object.values(row).some(contains), 'Mock marker found in formal storage')
      }
    } finally {
      database.close()
    }
  }
  return { files: files.length, sqliteFiles, markersExcluded: true }
}

export async function runMockSmoke(candidate) {
  const report = {
    ok: false,
    checks: [],
    realCaptureStarted: false,
    modelRequests: 0,
    platformSends: 0,
    liveServiceWrites: false,
  }
  let stage = 'arguments'
  let profile
  let application
  let page
  let mobileStarted = false
  const secrets = []
  const checked = name => report.checks.push(name)
  const waitFor = async read => {
    for (const deadline = Date.now() + 15000; Date.now() < deadline; ) {
      const value = await read()
      if (value) return value
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('Owned acceptance condition did not settle')
  }
  try {
    assert.ok(isAbsolute(candidate), 'Supply an absolute packaged executable')
    const executablePath = await realpath(candidate)
    profile = await mkdtemp(join(tmpdir(), 'oba-mock-assistant-smoke-'))
    await chmod(profile, 0o700)
    const environment = { ...process.env, OBA_USER_DATA_DIR: profile, OBA_DIRECTOR_API_PORT: '0' }
    for (const key of Object.keys(environment))
      if (
        [
          'ELECTRON_RUN_AS_NODE',
          'VITE_DEV_SERVER_URL',
          'OBA_DEBUG_PORT',
          'OBA_DIRECTOR_API_URL',
          'OBA_DIRECTOR_API_TOKEN',
        ].includes(key) ||
        /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN)$/.test(key)
      )
        delete environment[key]
    stage = 'owned-child-launch'
    const { _electron } = await import('playwright')
    application = await _electron.launch({
      executablePath,
      args: [
        ...(process.platform === 'darwin' ? [] : ['--assistant-desk']),
        `--user-data-dir=${profile}`,
      ],
      env: environment,
      timeout: 60000,
    })
    const info = await application.evaluate(({ app }) => ({
      profile: app.getPath('userData'),
      executable: process.execPath,
      pid: process.pid,
      packaged: app.isPackaged,
      version: app.getVersion(),
    }))
    assert.equal(await realpath(info.profile), await realpath(profile))
    assert.equal(await realpath(info.executable), executablePath)
    assert.equal(info.packaged, true)
    await application.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.hide()
    })
    report.version = info.version
    checked('owned-profile-and-packaged-executable')
    page = await application.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => typeof window.ipcRenderer?.invoke === 'function')
    const invoke = (channel, command, expectedSource) =>
      page.evaluate(
        ([name, input, source]) => window.ipcRenderer.invoke(name, input, source),
        [channel, command, expectedSource],
      )
    const success = async result => {
      assert.equal(result.ok, true, result.error?.code ?? 'IPC failed')
      return result.data
    }
    const realSource = { mode: 'real' }
    const desk = (action, params = {}) =>
      invoke(
        'assistant-desk:request',
        {
          action,
          params: { accountId: 'default', ...params },
        },
        ['context-save', 'policy-save', 'reply-policy-save'].includes(action)
          ? realSource
          : undefined,
      ).then(success)
    const mock = (action, extra = {}) =>
      invoke('mock-assistant:request', { action, accountId: 'default', ...extra }).then(success)
    stage = 'disable-all-automatic-work'
    const realBefore = await desk('state')
    assert.equal(realBefore.activeSession, undefined)
    assert.equal(realBefore.rows.length, 0)
    assert.equal(realBefore.sessions.length, 0)
    assert.equal(realBefore.audience.length, 0)
    assert.equal(realBefore.database.engine, 'sqlite')
    await desk('context-save', {
      expectedRevision: realBefore.context.revision,
      context: {
        ...realBefore.context,
        translationEnabled: false,
        translationMode: 'local',
        replyMode: 'off',
        aiPaused: true,
        aiRequestLimit: 0,
        localEffectsEnabled: false,
      },
    })
    await desk('reply-policy-save', {
      expectedRevision: realBefore.replyPolicy.revision,
      policy: { enabled: false, rules: [] },
    })
    await desk('policy-save', {
      expectedRevision: realBefore.audiencePolicy.revision,
      policy: {
        enabled: true,
        rules: [
          {
            id: 'smoke-thai',
            label: 'Synthetic country and level',
            enabled: true,
            priority: 1,
            conditions: [
              { field: 'manualCountry', operator: 'eq', value: 'TH' },
              { field: 'payLevel', operator: 'gte', value: 20 },
            ],
            result: { tier: 'gold', label: 'Synthetic', autoAttention: true },
          },
        ],
      },
    })
    const safe = await desk('state')
    assert.equal(safe.context.aiRequestLimit, 0)
    assert.equal(safe.context.translationEnabled, false)
    assert.equal(safe.context.aiPaused, true)
    assert.equal(safe.context.localEffectsEnabled, false)
    assert.equal(safe.replyPolicy.enabled, false)
    checked('automatic-ai-replies-and-effects-disabled')
    stage = 'owned-director-endpoint'
    const endpoint = await waitFor(async () => {
      try {
        return JSON.parse(await readFile(join(profile, 'director-api.json'), 'utf8'))
      } catch {
        return undefined
      }
    })
    assert.equal(endpoint.pid, info.pid)
    assert.equal(new URL(endpoint.url).hostname, '127.0.0.1')
    assert.ok(endpoint.port > 0 && endpoint.token.length >= 16)
    secrets.push(endpoint.token)
    const http = async (
      base,
      path,
      { token, body, method = body === undefined ? 'GET' : 'POST' } = {},
    ) => {
      const response = await fetch(new URL(path, base), {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      })
      const raw = await response.text()
      let data
      try {
        data = JSON.parse(raw)
      } catch {
        data = raw
      }
      return { status: response.status, data }
    }
    checked('ephemeral-director-endpoint-owned-pid')
    stage = 'worker-api-contract'
    const access = (await mock('api-start')).access
    assert.equal(access.active, true)
    assert.ok(access.token && access.token !== endpoint.token)
    secrets.push(access.token)
    const apiBase = access.urls.find(url => new URL(url).hostname === '127.0.0.1')
    assert.ok(apiBase)
    const docs = await http(apiBase, '/mock/docs')
    const openapi = await http(apiBase, '/mock/openapi.json')
    assert.equal(docs.status, 200)
    assert.equal(openapi.data.openapi, '3.1.0')
    assert.equal((await http(apiBase, '/mock/metadata')).status, 401)
    const metadataResponse = await http(apiBase, '/mock/metadata', { token: access.token })
    assert.equal(metadataResponse.status, 200)
    const metadata = await success(metadataResponse.data)
    assert.equal(metadata.metadataRevision, (await mock('metadata')).metadataRevision)
    const marker = `MOCK_ONLY_${randomUUID().replaceAll('-', '')}`
    const batch = buildSmokeBatch(metadata, marker)
    assert.equal(
      (
        await http(apiBase, '/mock/batches', {
          token: access.token,
          body: { ...batch, unexpected: true },
        })
      ).status,
      400,
    )
    const prepared = await http(apiBase, '/mock/batches', { token: access.token, body: batch })
    assert.equal(prepared.status, 201)
    assert.equal(prepared.data.data.phase, 'prepared')
    assert.equal(prepared.data.data.selected, false)
    for (const path of ['/mock/start', '/mock/send'])
      assert.equal((await http(apiBase, path, { token: access.token, body: {} })).status, 404)
    checked('worker-docs-auth-validation-prepare-only')
    stage = 'mock-start-and-history'
    const running = await mock('start')
    assert.equal(running.runtime.phase, 'running')
    const runId = running.runtime.runId
    assert.ok(runId)
    await waitFor(async () => (await mock('status')).runtime.emitted === batch.events.length)
    const current = await desk('state')
    assert.equal(current.provenance.mode, 'mock')
    assert.equal(current.provenance.runId, runId)
    assert.equal(current.database.engine, 'memory')
    assert.equal(current.activeSession.status, 'collecting')
    assert.equal(current.ai.used, 0)
    assert.equal(current.rows.length, batch.events.length)
    assert.ok(
      current.rows.every(row => row.provenance?.runId === runId && row.reply.status === 'none'),
    )
    const comment = current.rows.find(
      row => row.kind === 'comment' && row.original.includes(`${marker}_TEXT`),
    )
    assert.equal(comment.payLevel, 25)
    assert.equal(comment.triage.country.code, 'TH')
    assert.equal(comment.triage.country.source, 'manual')
    assert.equal(comment.triage.matchedRuleId, 'smoke-thai')
    const unknown = current.rows.find(row => row.nickname.endsWith('_UNKNOWN'))
    assert.equal(unknown.payLevel, undefined)
    assert.equal(unknown.triage.country.source, 'unknown')
    assert.equal((await desk('timeline', { limit: 200 })).items.length, batch.events.length)
    const directorState = await http(endpoint.url, '/assistant/command', {
      token: endpoint.token,
      body: { action: 'state', params: { accountId: 'default' } },
    })
    assert.equal(directorState.status, 200)
    assert.equal(directorState.data.data.provenance.runId, runId)
    const mockSource = { mode: 'mock', runId }
    const staleRealWrite = await invoke(
      'assistant-desk:request',
      {
        action: 'context-save',
        params: {
          accountId: 'default',
          expectedRevision: current.context.revision,
          context: { ...current.context, knowledge: `${marker}_STALE_REAL_WRITE` },
        },
      },
      realSource,
    )
    assert.equal(staleRealWrite.ok, false)
    assert.equal(staleRealWrite.error.code, 'ASSISTANT_SOURCE_CHANGED')
    assert.equal((await desk('state')).context.knowledge, current.context.knowledge)
    checked('private-replay-classification-ram-history-and-director-routing')
    stage = 'authenticated-phone-snapshot'
    const mobile = await success(
      await invoke('assistant-mobile:request', { action: 'start', accountId: 'default' }),
    )
    mobileStarted = true
    assert.ok(mobile.urls.length > 0)
    const phoneUrl = new URL(mobile.urls[0])
    phoneUrl.hostname = '127.0.0.1'
    const phoneBase = phoneUrl.href
    secrets.push(new URL(phoneBase).pathname.split('/')[1])
    const phone = await http(phoneBase, 'api/state')
    assert.equal(phone.status, 200)
    assert.equal(phone.data.data.provenance.mode, 'mock')
    assert.equal(phone.data.data.provenance.runId, runId)
    assert.equal(phone.data.data.sessionId, current.activeSession.id)
    assert.deepEqual(
      new Set(phone.data.data.rows.map(row => row.id)),
      new Set(current.rows.map(row => row.id)),
    )
    assert.equal((await http(phoneBase, '/api/state')).status, 404)
    assert.equal((await http(phoneBase, 'mock/start', { body: {} })).status, 404)
    checked('phone-token-current-mock-run-and-rows-no-create-route')
    stage = 'manual-deepseek-entry-contract-only'
    await page.getByRole('heading', { name: '助播台', exact: true }).waitFor()
    await page
      .locator('header')
      .filter({ hasText: 'LIVE ASSISTANT' })
      .getByRole('button', { name: '刷新状态', exact: true })
      .click()
    const manual = page.getByRole('button', { name: 'DeepSeek 翻译', exact: true })
    await manual.first().waitFor()
    assert.ok((await manual.count()) >= 1)
    assert.equal(
      await manual.first().isDisabled(),
      true,
      'zero quota must keep the model control disabled',
    )
    const refused = await invoke(
      'assistant-desk:request',
      {
        action: 'translate-retry',
        params: { accountId: 'default', rowId: comment.id },
      },
      mockSource,
    )
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'AI_REQUEST_LIMIT')
    assert.equal((await desk('state')).ai.used, 0)
    checked('manual-deepseek-visible-with-zero-quota-guard-no-model-request')
    stage = 'stop-clear-leave-isolation'
    await mock('stop')
    assert.equal((await desk('timeline', { limit: 200 })).items.length, batch.events.length)
    assert.equal((await mock('status')).runtime.selected, true)
    await mock('clear')
    const blank = await desk('state')
    assert.equal(blank.rows.length, 0)
    assert.equal((await desk('timeline', { limit: 200 })).items.length, 0)
    assert.notEqual(blank.provenance.runId, runId)
    assert.equal(blank.database.engine, 'memory')
    stage = 'ram-local-effects-start-flag'
    const effectBatch = buildSmokeBatch(await mock('metadata'), marker)
    effectBatch.name = 'Owned comment-only flag acceptance'
    effectBatch.durationMs = 1
    effectBatch.events = [
      {
        id: 'flag-comment',
        userId: effectBatch.users[0].id,
        atMs: 0,
        kind: 'comment',
        text: `${marker}_FLAG_COMMENT`,
      },
    ]
    await mock('prepare', { batch: effectBatch })
    for (const enabled of [true, false]) {
      await mock('start', { playLocalEffects: enabled })
      await waitFor(async () => (await mock('status')).runtime.emitted === 1)
      const flagState = await desk('state')
      assert.equal(flagState.context.localEffectsEnabled, enabled)
      assert.equal(flagState.context.translationEnabled, false)
      assert.equal(flagState.context.aiRequestLimit, 0)
      assert.equal(flagState.ai.used, 0)
      const flagRows = flagState.rows.filter(row => row.sessionId === flagState.activeSession.id)
      assert.equal(flagRows.length, 1)
      assert.equal(flagRows[0].kind, 'comment')
      assert.ok(flagState.rows.every(row => row.kind === 'comment'))
      assert.equal(flagState.database.engine, 'memory')
      await mock('stop')
    }
    checked('explicit-start-effects-flag-changes-ram-only-on-comment-only-replay')
    stage = 'leave-restores-owned-real-settings'
    await mock('leave')
    const realAfter = await desk('state')
    assert.equal(realAfter.provenance, undefined)
    assert.equal(realAfter.database.engine, 'sqlite')
    assert.equal(realAfter.activeSession, undefined)
    assert.equal(realAfter.rows.length, 0)
    assert.equal(realAfter.audience.length, 0)
    assert.equal(realAfter.sessions.length, 0)
    assert.equal(realAfter.context.aiRequestLimit, 0)
    assert.equal(realAfter.context.localEffectsEnabled, false)
    const staleMockWrite = await invoke(
      'assistant-desk:request',
      {
        action: 'context-save',
        params: {
          accountId: 'default',
          expectedRevision: realAfter.context.revision,
          context: { ...realAfter.context, knowledge: `${marker}_STALE_MOCK_WRITE` },
        },
      },
      mockSource,
    )
    assert.equal(staleMockWrite.ok, false)
    assert.equal(staleMockWrite.error.code, 'ASSISTANT_SOURCE_CHANGED')
    assert.equal((await desk('state')).context.knowledge, realAfter.context.knowledge)
    checked('desktop-mutations-reject-stale-real-and-mock-source-markers')
    checked('stop-retains-history-clear-replaces-run-leave-restores-real-store')
    stage = 'worker-token-revocation'
    // Leave revokes this listener. Reopening must reject the old token on the new listener too.
    const reopened = (await mock('api-start')).access
    secrets.push(reopened.token)
    assert.notEqual(reopened.token, access.token)
    const newBase = reopened.urls.find(url => new URL(url).hostname === '127.0.0.1')
    assert.equal((await http(newBase, '/mock/metadata', { token: access.token })).status, 401)
    await mock('api-stop')
    let oldDenied = false
    try {
      oldDenied = (await http(newBase, '/mock/metadata', { token: reopened.token })).status !== 200
    } catch {
      oldDenied = true
    }
    assert.equal(oldDenied, true)
    checked('worker-close-revokes-token-and-reopen-rotates-it')
    await invoke('assistant-mobile:request', { action: 'stop', accountId: 'default' })
    mobileStarted = false
    await application.close()
    application = undefined
    stage = 'formal-storage-marker-scan'
    report.storage = await scanFormalStorage(profile, [marker])
    assert.ok(report.storage.sqliteFiles > 0)
    checked('formal-json-journal-and-sqlite-exclude-synthetic-markers')
    report.ok = true
  } catch (error) {
    let message = error instanceof Error ? error.message : 'Packaged acceptance failed'
    for (const secret of secrets.filter(Boolean)) message = message.replaceAll(secret, '[redacted]')
    report.failure = { stage, message: message.slice(0, 1000) }
  } finally {
    if (mobileStarted && page)
      await page
        .evaluate(() =>
          window.ipcRenderer.invoke('assistant-mobile:request', {
            action: 'stop',
            accountId: 'default',
          }),
        )
        .catch(() => {})
    if (application) await application.close().catch(() => {})
    if (profile) {
      const cleanupTarget = relative(resolve(tmpdir()), resolve(profile))
      assert.ok(
        cleanupTarget.startsWith('oba-mock-assistant-smoke-') &&
          !cleanupTarget.includes('..') &&
          !isAbsolute(cleanupTarget),
      )
      await rm(profile, { recursive: true, force: true })
    }
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result =
    process.argv.length === 3
      ? await runMockSmoke(process.argv[2])
      : {
          ok: false,
          failure: {
            stage: 'arguments',
            message: 'Supply exactly one absolute packaged executable path',
          },
        }
  console.log(JSON.stringify(result))
  if (!result.ok) process.exitCode = 1
}
