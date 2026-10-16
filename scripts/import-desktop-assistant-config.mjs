// Import operator configuration into the running full Electron desktop app.
// Usage: node scripts/import-desktop-assistant-config.mjs PRIVATE_CONFIG ABSOLUTE_USER_DATA
// Start the target desktop app with that profile and stop capture before importing.
// Uses the existing desktop API and optimistic revisions; never starts/stops capture.
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { validateDeskHttp } from '../shared/assistantDeskContract.mjs'

const applied = []
let failedAction, outcomeUnknown = false
const steps = [['context-save', 'context', 'context'], ['policy-save', 'audiencePolicy', 'policy'], ['reply-policy-save', 'replyPolicy', 'policy']]
// These service checks happen before persistence. Other errors can follow a commit.
const preCommitRejections = new Set(['CONTEXT_CONFLICT', 'POLICY_CONFLICT', 'REPLY_POLICY_CONFLICT', 'INVALID_CONTEXT', 'INVALID_POLICY', 'INVALID_REPLY_POLICY', 'ACCOUNT_LIMIT', 'CAPTURE_ACTIVE'])
function fail(code) { throw Object.assign(new Error(code), { code }) }
function validCode(value) { return typeof value === 'string' && /^[A-Z_]{1,80}$/.test(value) }

async function main() {
  const [configFile, profile, ...extra] = process.argv.slice(2)
  if (!configFile || !profile || extra.length || !isAbsolute(profile)) fail('CONFIG_AND_ABSOLUTE_USER_DATA_REQUIRED')
  let config, raw
  try {
    raw = await readFile(configFile)
    if (raw.length > 2 * 1024 * 1024) fail('CONFIG_FILE_TOO_LARGE')
    config = JSON.parse(raw.toString('utf8'))
    const fields = ['format', 'version', 'exportedAt', 'sourceVersion', 'accountId', 'context', 'audiencePolicy', 'replyPolicy', 'exclusions']
    if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !fields.includes(key)) || config.format !== 'oba-assistant-config' || config.version !== 1 || config.accountId !== 'default') fail('INVALID_CONFIG_HANDOFF')
    // Validate every command before the first mutation; extra keys cannot carry secrets/history.
    for (const [action, field, parameter] of steps)
      validateDeskHttp('/assistant/command', { action, params: { accountId: config.accountId, expectedRevision: 1, requireStopped: true, [parameter]: config[field] } })
  } catch (error) {
    fail(error?.code === 'CONFIG_FILE_TOO_LARGE' ? error.code : 'INVALID_CONFIG_HANDOFF')
  }

  let endpoint
  try {
    const descriptor = await readFile(join(profile, 'director-api.json'), 'utf8')
    if (Buffer.byteLength(descriptor) > 16384) fail('INVALID_DESKTOP_ENDPOINT')
    endpoint = JSON.parse(descriptor)
  } catch { fail('START_TARGET_DESKTOP_APP_FIRST') }
  // Check the raw URL before URL() can normalize shortened IPv4 or path segments.
  const match = typeof endpoint?.url === 'string' && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})\/?$/.exec(endpoint.url)
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) fail('LOCAL_DESKTOP_ENDPOINT_REQUIRED')
  if (typeof endpoint.token !== 'string' || !/^[\x21-\x7e]{16,512}$/.test(endpoint.token)) fail('INVALID_DESKTOP_ENDPOINT')
  const commandUrl = new URL('/assistant/command', endpoint.url)
  async function command(action, params, mutation = false) {
    try {
      const response = await fetch(commandUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'x-oba-token': endpoint.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, params }) })
      const result = await response.json()
      if (result.ok === false && validCode(result.error?.code) && (!mutation || preCommitRejections.has(result.error.code)))
        throw Object.assign(new Error('Command rejected'), { code: result.error.code, rejected: true })
      if (!response.ok || result.ok !== true) throw new Error('Unexpected desktop response')
      return result.data
    } catch (error) {
      if (error?.rejected === true) throw error
      if (mutation) { outcomeUnknown = true; fail('CONFIG_IMPORT_OUTCOME_UNKNOWN') }
      fail('DESKTOP_API_UNAVAILABLE')
    }
  }
  const fingerprint = createHash('sha256').update(raw).digest('hex').slice(0, 24)
  for (const [action, field, parameter] of steps) {
    failedAction = action
    const state = await command('state', { accountId: config.accountId })
    if (!state || typeof state !== 'object') fail('TARGET_CONFIG_REVISION_UNAVAILABLE')
    if (state.activeSession) fail('STOP_CAPTURE_BEFORE_CONFIG_IMPORT')
    const revision = state[field]?.revision
    if (!Number.isSafeInteger(revision) || revision < (action === 'reply-policy-save' ? 1 : 0)) fail('TARGET_CONFIG_REVISION_UNAVAILABLE')
    const result = await command(action, { accountId: config.accountId, expectedRevision: revision, requireStopped: true, [parameter]: config[field],
      ...(action === 'reply-policy-save' ? { requestId: `config-import-${fingerprint}-${revision}` } : {}) }, true)
    if (result?.revision !== revision + 1) { outcomeUnknown = true; fail('CONFIG_IMPORT_OUTCOME_UNKNOWN') }
    applied.push({ action, revision: result.revision })
  }
  console.log(JSON.stringify({ imported: true, applied, audienceRecordsImported: 0, credentialsImported: false }))
}

main().catch(error => {
  // Only fixed status fields leave the process: never provider messages, config, URLs or tokens.
  console.error(JSON.stringify({ imported: false, applied, code: validCode(error?.code) ? error.code : 'CONFIG_IMPORT_FAILED',
    partial: applied.length > 0 || outcomeUnknown, outcomeUnknown, ...(failedAction ? { failedAction } : {}) }))
  process.exitCode = 1
})
