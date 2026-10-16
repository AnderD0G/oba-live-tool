import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { DirectorApiHost } from '../electron/main/services/DirectorApiHost'
import { AssistantDeskService } from '../electron/main/services/assistantDesk/AssistantDeskService'
import { validateDeskHttp } from '../shared/assistantDeskContract.mjs'

const run = promisify(execFile)
const script = resolve('scripts/import-desktop-assistant-config.mjs')

async function fixture(t: any) {
  const folder = await mkdtemp(join(tmpdir(), 'oba-desktop-config-'))
  let captures = 0, sends = 0
  const service = new AssistantDeskService(join(folder, 'assistant-desk'), {
    interpret: async () => { throw new Error('Importer must not invoke AI') },
    send: async () => { sends++ },
    startCapture: async () => { captures++; return { release: async () => {} } },
  })
  const command = (action: string, params: any = {}) => service.execute({ action, params: { accountId: 'default', ...params } } as any)
  const state = async () => { const result = await command('state'); assert.equal(result.ok, true); return (result as any).data }
  let dispatch = (value: any) => service.execute(value)
  const host = new DirectorApiHost({ userDataDir: folder, port: 0, log: () => {}, facade: { assistantDesk: (value: any) => dispatch(value) } as any })
  await host.start()
  t.after(async () => { await host.stop(); await service.shutdown(); await rm(folder, { recursive: true, force: true }) })
  const initial = await state()
  const config = { format: 'oba-assistant-config', version: 1, accountId: 'default',
    context: { ...initial.context, revision: 900, knowledge: 'PRIVATE knowledge fixture', instructions: 'PRIVATE instructions', replyMode: 'auto', aiPaused: false },
    audiencePolicy: { ...initial.audiencePolicy, revision: 800 },
    replyPolicy: { ...initial.replyPolicy, revision: 700, enabled: true, rules: [{ id: 'comment', enabled: true, action: 'comment', mode: 'auto', priority: 100, knowledge: 'PRIVATE action knowledge', instructions: 'PRIVATE action instructions' }] } }
  const source = join(folder, 'private-config.json')
  const execute = async (value = config) => {
    await writeFile(source, JSON.stringify(value))
    try { const result = await run(process.execPath, [script, source, folder], { windowsHide: true, timeout: 20000 }); return { ...result, code: 0, receipt: JSON.parse(result.stdout) } }
    catch (error: any) { return { stdout: error.stdout, stderr: error.stderr, code: error.code, receipt: error.stderr?.trim().startsWith('{') ? JSON.parse(error.stderr) : undefined } }
  }
  return { folder, config, command, state, service, execute, dispatch: (value: typeof dispatch) => { dispatch = value }, captures: () => captures, sends: () => sends }
}

test('desktop importer saves with target revisions on SQLite and preserves credentials and stopped history', async t => {
  const f = await fixture(t)
  await f.command('start'); await f.command('stop')
  const before = await f.state()
  const credential = join(f.folder, 'keys-and-cookies.fixture')
  await writeFile(credential, 'PRIVATE credentials that must stay local')
  const endpointBefore = await readFile(join(f.folder, 'director-api.json'), 'utf8')
  const result = await f.execute()
  assert.equal(result.code, 0, 'Desktop config import should succeed')
  assert.equal(result.receipt.imported, true)
  assert.deepEqual(result.receipt.applied.map((item: any) => item.action), ['context-save', 'policy-save', 'reply-policy-save'])
  assert.equal(result.receipt.credentialsImported, false); assert.equal(result.receipt.audienceRecordsImported, 0)
  assert.ok(!result.stdout.includes('PRIVATE')); assert.ok(!result.stderr.includes('PRIVATE'))
  assert.ok(!result.stdout.includes(JSON.parse(endpointBefore).token))
  const after = await f.state()
  assert.equal(after.context.revision, before.context.revision + 1)
  assert.equal(after.audiencePolicy.revision, before.audiencePolicy.revision + 1)
  assert.equal(after.replyPolicy.revision, before.replyPolicy.revision + 1)
  assert.equal(after.context.knowledge, 'PRIVATE knowledge fixture')
  assert.equal(after.replyPolicy.rules[0].knowledge, 'PRIVATE action knowledge')
  assert.equal(after.context.replyMode, 'auto'); assert.equal(after.activeSession, undefined)
  assert.deepEqual(after.sessions, before.sessions); assert.deepEqual(after.rows, before.rows)
  assert.equal(f.captures(), 1); assert.equal(f.sends(), 0)
  assert.equal(await readFile(credential, 'utf8'), 'PRIVATE credentials that must stay local')
  assert.equal(await readFile(join(f.folder, 'director-api.json'), 'utf8'), endpointBefore)
})

test('desktop importer refuses active capture without changing configuration or stopping capture', async t => {
  const f = await fixture(t)
  await f.command('start')
  const before = await f.state(), result = await f.execute(), after = await f.state()
  assert.equal(result.receipt?.code, 'STOP_CAPTURE_BEFORE_CONFIG_IMPORT')
  assert.equal(result.receipt.partial, false); assert.deepEqual(result.receipt.applied, [])
  assert.deepEqual(after.context, before.context); assert.deepEqual(after.audiencePolicy, before.audiencePolicy)
  assert.equal(after.activeSession.id, before.activeSession.id); assert.equal(f.captures(), 1); assert.equal(f.sends(), 0)
})

test('desktop importer rejects unsupported account IDs before creating hidden account configuration', async t => {
  const f = await fixture(t), before = await f.state()
  const result = await f.execute({ ...f.config, accountId: 'ghost-account' })
  assert.equal(result.receipt?.code, 'INVALID_CONFIG_HANDOFF')
  assert.equal(result.receipt.partial, false); assert.deepEqual(result.receipt.applied, [])
  const ghost = await f.command('state', { accountId: 'ghost-account' }) as any
  assert.equal(ghost.data.context.revision, 1); assert.equal(ghost.data.context.knowledge, '')
  assert.deepEqual((await f.state()).context, before.context)
})

test('desktop importer rejects capture started between stopped state and each save without mutating that configuration', async t => {
  for (const [action, field, appliedCount] of [['context-save', 'context', 0], ['policy-save', 'audiencePolicy', 1], ['reply-policy-save', 'replyPolicy', 2]] as const) {
    const f = await fixture(t), before = await f.state()
    f.dispatch(async value => {
      if (value.action === action) await f.command('start')
      return f.service.execute(value)
    })
    const result = await f.execute(), after = await f.state()
    assert.equal(result.receipt?.code, 'CAPTURE_ACTIVE', action)
    assert.equal(result.receipt.partial, appliedCount > 0); assert.equal(result.receipt.outcomeUnknown, false)
    assert.equal(result.receipt.applied.length, appliedCount)
    assert.deepEqual(after[field], before[field]); assert.ok(after.activeSession)
    assert.equal(f.captures(), 1); assert.equal(f.sends(), 0)
  }
})

test('guarded saves check capture inside the mutation queue while ordinary saves retain active-capture behavior', async t => {
  for (const [action, field, parameter] of [['context-save', 'context', 'context'], ['policy-save', 'audiencePolicy', 'policy'], ['reply-policy-save', 'replyPolicy', 'policy']] as const) {
    const f = await fixture(t), before = await f.state()
    const params = { expectedRevision: before[field].revision, [parameter]: f.config[field], requireStopped: true }
    const starting = f.command('start')
    const saving = f.command(action, params)
    assert.equal((await starting).ok, true)
    const rejected = await saving as any
    assert.equal(rejected.ok, false, action); assert.equal(rejected.error.code, 'CAPTURE_ACTIVE')
    assert.deepEqual((await f.state())[field], before[field])
    const { requireStopped: _guard, ...ordinaryParams } = params
    assert.equal((await f.command(action, ordinaryParams)).ok, true, `${action} without guard must preserve existing behavior`)
    assert.equal((await f.state())[field].revision, before[field].revision + 1)
    assert.equal(f.sends(), 0)
  }
})

test('desktop contract preserves the optional stopped-capture guard and rejects non-boolean values', async t => {
  const f = await fixture(t)
  for (const [action, field, parameter] of [['context-save', 'context', 'context'], ['policy-save', 'audiencePolicy', 'policy'], ['reply-policy-save', 'replyPolicy', 'policy']] as const) {
    const params = { accountId: 'default', expectedRevision: 1, [parameter]: f.config[field] }
    assert.doesNotThrow(() => validateDeskHttp('/assistant/command', { action, params }))
    const guarded = { action, params: { ...params, requireStopped: true } }
    assert.deepEqual(validateDeskHttp('/assistant/command', guarded), guarded)
    assert.throws(() => validateDeskHttp('/assistant/command', { action, params: { ...params, requireStopped: 'true' } }))
  }
})

test('desktop importer reports partial failure after context save and does not retry a rejected policy', async t => {
  const f = await fixture(t), before = await f.state()
  const config = structuredClone(f.config)
  config.audiencePolicy.rules[0].conditions = [{ field: 'manualCountry', operator: 'eq', value: 'ZZ' }] as any
  const result = await f.execute(config)
  assert.equal(result.code, 1)
  assert.equal(result.receipt?.partial, true); assert.equal(result.receipt.outcomeUnknown, false)
  assert.deepEqual(result.receipt.applied.map((item: any) => item.action), ['context-save'])
  const after = await f.state()
  assert.equal(after.context.revision, before.context.revision + 1)
  assert.deepEqual(after.audiencePolicy, before.audiencePolicy); assert.deepEqual(after.replyPolicy, before.replyPolicy)
  assert.ok(!result.stderr.includes('PRIVATE')); assert.equal(f.captures(), 0); assert.equal(f.sends(), 0)
})

test('lost save acknowledgement is reported as potentially partial without retry or later saves', async t => {
  const f = await fixture(t), before = await f.state()
  f.dispatch(async value => {
    const result = await f.service.execute(value)
    if (value.action === 'context-save') throw new Error('PRIVATE transport failure')
    return result
  })
  const result = await f.execute()
  assert.equal(result.receipt?.code, 'CONFIG_IMPORT_OUTCOME_UNKNOWN')
  assert.equal(result.receipt.partial, true); assert.equal(result.receipt.outcomeUnknown, true)
  assert.equal(result.receipt.failedAction, 'context-save'); assert.deepEqual(result.receipt.applied, [])
  const after = await f.state()
  assert.equal(after.context.revision, before.context.revision + 1)
  assert.deepEqual(after.audiencePolicy, before.audiencePolicy); assert.deepEqual(after.replyPolicy, before.replyPolicy)
  assert.ok(!result.stderr.includes('PRIVATE'))
})

test('a service failure after persistence is reported as uncertain rather than claiming no changes', async t => {
  const f = await fixture(t), before = await f.state()
  f.dispatch(async value => {
    const result = await f.service.execute(value)
    return value.action === 'context-save' ? { ok: false, error: { code: 'ASSISTANT_FAILED', message: 'PRIVATE failure after commit' } } as any : result
  })
  const result = await f.execute(), after = await f.state()
  assert.equal(result.receipt?.code, 'CONFIG_IMPORT_OUTCOME_UNKNOWN')
  assert.equal(result.receipt.partial, true); assert.equal(result.receipt.outcomeUnknown, true)
  assert.deepEqual(result.receipt.applied, []); assert.equal(result.receipt.failedAction, 'context-save')
  assert.equal(after.context.revision, before.context.revision + 1)
  assert.deepEqual(after.replyPolicy, before.replyPolicy); assert.ok(!result.stderr.includes('PRIVATE'))
})

test('concurrent policy edit is preserved and revision conflict is never retried', async t => {
  const f = await fixture(t)
  let raced = false
  f.dispatch(async value => {
    if (value.action === 'policy-save' && !raced) {
      raced = true
      const current = await f.state()
      await f.command('policy-save', { expectedRevision: current.audiencePolicy.revision, policy: { ...current.audiencePolicy, enabled: false } })
    }
    return f.service.execute(value)
  })
  const before = await f.state(), result = await f.execute(), after = await f.state()
  assert.equal(result.receipt?.code, 'POLICY_CONFLICT')
  assert.equal(result.receipt.partial, true); assert.equal(after.audiencePolicy.enabled, false)
  assert.equal(after.audiencePolicy.revision, before.audiencePolicy.revision + 1)
  assert.deepEqual(after.replyPolicy, before.replyPolicy)
})

test('desktop importer rejects credential/history fields before any configuration save', async t => {
  const f = await fixture(t), before = await f.state()
  for (const extra of [{ history: [{ private: 'PRIVATE' }] }, { apiKey: 'PRIVATE' }]) {
    const result = await f.execute({ ...f.config, ...extra })
    assert.equal(result.receipt?.code, 'INVALID_CONFIG_HANDOFF')
    assert.equal(result.receipt.partial, false); assert.deepEqual(result.receipt.applied, [])
  }
  const result = await f.execute({ ...f.config, context: { ...f.config.context, apiKey: 'PRIVATE' } })
  assert.equal(result.receipt?.code, 'INVALID_CONFIG_HANDOFF')
  assert.deepEqual((await f.state()).context, before.context)
})

test('desktop importer rejects remote, redirected-path and credential-bearing endpoint descriptors', async t => {
  const f = await fixture(t), before = await f.state()
  const endpoint = JSON.parse(await readFile(join(f.folder, 'director-api.json'), 'utf8'))
  for (const url of ['http://192.0.2.1:17892', 'http://127.0.0.1:17892/other', 'http://user:PRIVATE@127.0.0.1:17892', 'http://127.1:17892', 'http://127.0.0.1:17892/?token=PRIVATE']) {
    await writeFile(join(f.folder, 'director-api.json'), JSON.stringify({ ...endpoint, url }))
    const result = await f.execute()
    assert.equal(result.receipt?.code, 'LOCAL_DESKTOP_ENDPOINT_REQUIRED')
    assert.equal(result.receipt.partial, false); assert.ok(!result.stderr.includes('PRIVATE'))
  }
  assert.deepEqual((await f.state()).context, before.context)
})
