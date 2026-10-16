// Export only operator configuration, never credentials, profiles or audience history.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

assert.ok(process.argv[2], 'Supply a private output filename outside source control')
const output = resolve(process.argv[2])
const browser = await chromium.connectOverCDP('http://127.0.0.1:9224', { timeout: 15000 })
try {
  const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('index.html'))
  assert.ok(page, 'Own OBA application page missing')
  const state = await page.evaluate(() => window.ipcRenderer.invoke('assistant-desk:request', { action: 'state', params: { accountId: 'default' } }))
  assert.equal(state.ok, true)
  assert.ok(!state.data.activeSession, 'Export after the test capture has stopped')
  const fields = ['revision', 'knowledge', 'instructions', 'replyMode', 'translationEnabled', 'translationMode', 'aiRequestLimit', 'goldLevel', 'priorityGold', 'aiPaused', 'localEffectsEnabled', 'attentionMaxAgeSeconds']
  const context = Object.fromEntries(fields.filter(field => state.data.context[field] !== undefined).map(field => [field, state.data.context[field]]))
  const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
  const document = { format: 'oba-assistant-config', version: 1, exportedAt: new Date().toISOString(), sourceVersion: version, accountId: 'default',
    context, audiencePolicy: state.data.audiencePolicy, replyPolicy: state.data.replyPolicy,
    exclusions: ['API keys', 'login profiles', 'tokens', 'audience records', 'capture history', 'OBS scenes'] }
  await writeFile(output, JSON.stringify(document, null, 2), { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ exported: true, output, contextRevision: context.revision, audiencePolicyRevision: document.audiencePolicy.revision, replyPolicyRevision: document.replyPolicy.revision, audienceRecordsExported: 0 }))
} finally { await browser.close() }
