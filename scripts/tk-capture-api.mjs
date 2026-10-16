import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

// Uses OBA's existing authenticated API. No browser control, credentials in output, or sends.
const [action = 'accounts', accountId, sessionId] = process.argv.slice(2)
const directory = process.env.OBA_USER_DATA_DIR || path.join(process.env.APPDATA || os.homedir(), 'OBA-Codex')
const endpoint = JSON.parse(await fs.readFile(path.join(directory, 'director-api.json'), 'utf8'))
const url = new URL(endpoint.url)
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Expected the local OBA API')
const scope = { accountId, platform: 'tiktok', source: 'control' }
const query = new URLSearchParams(scope)
if (sessionId) query.set('sessionId', sessionId)
let route, body
if (action === 'accounts') route = '/interaction/capabilities'
else if (action === 'camera') route = '/obs/camera'
else if (action === 'page') {
  if (!accountId) throw new Error('accountId is required; first run accounts')
  const pageQuery = new URLSearchParams({ accountId })
  if (sessionId) pageQuery.set('marker', sessionId)
  route = `/platform/page-diagnostics?${pageQuery}`
}
else if (['capabilities', 'sessions', 'records', 'fields'].includes(action)) {
  if (!accountId) throw new Error('accountId is required; first run accounts')
  if (['records', 'fields'].includes(action) && !sessionId) throw new Error('sessionId is required')
  route = `/analysis/${action}?${query}`
} else if (['start', 'stop'].includes(action)) {
  if (!accountId || (action === 'stop' && !sessionId)) throw new Error('Missing accountId/sessionId')
  route = `/analysis/${action}`
  body = { scope, requestId: randomUUID(), ...(action === 'stop' ? { sessionId } : {}) }
} else throw new Error('Usage: tk-capture-api.mjs accounts|camera|page|capabilities|start|stop|sessions|records|fields [accountId] [sessionId or page marker]')
try {
  const response = await fetch(new URL(route, url), {
    method: body ? 'POST' : 'GET',
    headers: { 'x-oba-token': endpoint.token, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60000),
  })
  const result = await response.json()
  console.log(JSON.stringify({ status: response.status, result }, null, 2))
  if (!response.ok || result.ok === false) process.exitCode = 1
} catch (error) {
  console.error(JSON.stringify({ error: error.message, hint: 'Start the new OBA version and connect the configured TikTok room first.' }))
  process.exitCode = 1
}
