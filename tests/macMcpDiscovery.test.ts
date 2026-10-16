import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { mcpFiles } from '../scripts/analysis-release-contract.mjs'

test('Mac MCP discovers both packaged and development Electron profiles in Application Support', async () => {
  const { userDataCandidates } = await import('../scripts/oba-user-data-candidates.mjs')
  assert.deepEqual(userDataCandidates({ platform: 'darwin', home: '/Users/operator', env: { APPDATA: 'C:\\wrong-host' } }), [
    '/Users/operator/Library/Application Support/OBA-Codex',
    '/Users/operator/Library/Application Support/oba-live-tool-codex',
  ])
})

test('Windows MCP retains APPDATA discovery and its home fallback', async () => {
  const { userDataCandidates } = await import('../scripts/oba-user-data-candidates.mjs')
  assert.deepEqual(userDataCandidates({ platform: 'win32', home: 'C:\\Users\\operator', env: { APPDATA: 'D:\\isolated-appdata' } }), [
    'D:\\isolated-appdata\\OBA-Codex', 'D:\\isolated-appdata\\oba-live-tool-codex',
  ])
  assert.deepEqual(userDataCandidates({ platform: 'win32', home: 'C:\\Users\\operator', env: {} }), [
    'C:\\Users\\operator\\AppData\\Roaming\\OBA-Codex',
    'C:\\Users\\operator\\AppData\\Roaming\\oba-live-tool-codex',
  ])
})

test('an explicit MCP user data directory is the only selected profile on either platform', async () => {
  const { userDataCandidates } = await import('../scripts/oba-user-data-candidates.mjs')
  for (const platform of ['darwin', 'win32']) assert.deepEqual(userDataCandidates({ platform, home: '/unused',
    env: { OBA_USER_DATA_DIR: '/explicit-profile', APPDATA: '/unrelated-profile' } }), ['/explicit-profile'])
})

async function callMcp(t: any, env: NodeJS.ProcessEnv, serverPath = path.resolve('scripts/mcp-director-server.mjs')) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, OBA_DIRECTOR_API_URL: '', OBA_DIRECTOR_API_TOKEN: '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  t.after(() => { child.stdin.end(); child.kill() })
  child.stderr.resume()
  child.stdout.setEncoding('utf8')
  return new Promise<any>((done, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('MCP fixture timed out')) }, 10000)
    let output = ''
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`MCP fixture exited before a reply (${code})`)) })
    child.stdout.on('data', chunk => {
      output += chunk
      if (!output.includes('\n')) return
      clearTimeout(timeout)
      try { done(JSON.parse(output.slice(0, output.indexOf('\n')))) } catch (error) { reject(error) }
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'director_state', arguments: {} } }) + '\n')
  })
}

test('real MCP stdio cannot fall through a missing explicit profile to another active profile', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'oba-mcp-profile-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const explicit = path.join(folder, 'explicit'), fallback = path.join(folder, 'OBA-Codex')
  await mkdir(explicit); await mkdir(fallback)
  let requests = 0
  const server = createServer((_request, response) => { requests++; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true, running: false, state: { profile: 'isolated-fixture' } })) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  t.after(() => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())))
  const address = server.address() as { port: number }
  const endpoint = { url: `http://127.0.0.1:${address.port}`, token: 'synthetic-token' }
  await writeFile(path.join(fallback, 'director-api.json'), JSON.stringify(endpoint))
  const missing = await callMcp(t, { OBA_USER_DATA_DIR: explicit, APPDATA: folder })
  assert.equal(missing.result.isError, true)
  assert.match(missing.result.content[0].text, /director-api\.json/)
  assert.equal(requests, 0, 'the unrelated profile must not receive any request')
  await writeFile(path.join(explicit, 'director-api.json'), JSON.stringify(endpoint))
  const selected = await callMcp(t, { OBA_USER_DATA_DIR: explicit, APPDATA: folder })
  assert.equal(selected.result.isError, undefined)
  assert.equal(JSON.parse(selected.result.content[0].text).state.profile, 'isolated-fixture')
  assert.equal(requests, 1)
})

test('the released MCP file list includes its full dependency closure outside the source checkout', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'oba-mcp-packaged-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  for (const name of mcpFiles) {
    const target = path.join(folder, name)
    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(path.resolve(name), target)
  }
  const response = await callMcp(t, { OBA_USER_DATA_DIR: folder, APPDATA: folder }, path.join(folder, 'scripts/mcp-director-server.mjs'))
  assert.equal(response.result.isError, true)
  assert.match(response.result.content[0].text, /director-api\.json/)
})

test('real MCP stdio still rejects an external API origin from an explicitly selected profile', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'oba-mcp-origin-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  await writeFile(path.join(folder, 'director-api.json'), JSON.stringify({ url: 'https://example.invalid', token: 'synthetic-token' }))
  const response = await callMcp(t, { OBA_USER_DATA_DIR: folder, APPDATA: folder })
  assert.equal(response.result.isError, true)
  assert.match(response.result.content[0].text, /API 必须绑定本机 HTTP 原点/)
})
