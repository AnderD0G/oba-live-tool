import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateDeskHttp } from '../shared/assistantDeskContract.mjs'

/** Chrome 144+ writes this only after its owner enables remote debugging. */
export function parseDevToolsActivePort(raw) {
  const lines = String(raw).trimEnd().split(/\r?\n/)
  if (lines.length !== 2 || !/^\d{1,5}$/.test(lines[0]) ||
      Number(lines[0]) < 1 || Number(lines[0]) > 65535 ||
      !/^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(lines[1])) {
    throw new Error('Chrome 调试端点文件无效；请重新检查远程调试设置')
  }
  return `ws://127.0.0.1:${Number(lines[0])}${lines[1]}`
}

export async function discoverChromeEndpoint(userDataFolder) {
  if (userDataFolder === undefined) {
    if (!process.env.LOCALAPPDATA) throw new Error('LOCALAPPDATA 未设置；无法确定 Chrome 配置目录')
    userDataFolder = path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data')
  }
  let raw
  try { raw = await fs.readFile(path.join(userDataFolder, 'DevToolsActivePort'), 'utf8') }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
  return parseDevToolsActivePort(raw)
}

async function main() {
  const args = process.argv.slice(2)
  const endpoint = await discoverChromeEndpoint()
  if (args[0] === '--check') {
    console.log(JSON.stringify({ ok: true, chromeReady: Boolean(endpoint) }))
    return
  }
  if (!endpoint) {
    console.log(JSON.stringify({ ok: false, error: { code: 'CHROME_DEBUG_NOT_ENABLED', message: '当前 Chrome 尚未开放本机调试连接。请人工打开 chrome://inspect/#remote-debugging，启用调试并允许 OBA 的连接请求。保留现有登录窗口。' } }))
    process.exitCode = 2
    return
  }
  const [accountId, pageUrl] = args
  const command = validateDeskHttp('/platform/session/command', { action: 'attach-browser', accountId, endpoint, pageUrl })
  // The full OBA API credential stays in this local process; it is never placed in a web page.
  const api = JSON.parse(await fs.readFile(path.join(process.env.APPDATA, 'OBA-Codex', 'director-api.json'), 'utf8'))
  const apiUrl = new URL(api.url)
  if (apiUrl.protocol !== 'http:' || apiUrl.hostname !== '127.0.0.1' || apiUrl.username || apiUrl.password) throw new Error('OBA 本机接口地址无效')
  const response = await fetch(new URL('/platform/session/command', apiUrl), {
    method: 'POST', headers: { 'x-oba-token': api.token, 'content-type': 'application/json' },
    body: JSON.stringify(command), signal: AbortSignal.timeout(150000), redirect: 'error',
  })
  const result = await response.json()
  console.log(JSON.stringify(result))
  if (!response.ok || result.ok !== true) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => {
    // Do not expose endpoint paths, API credentials, provider errors or raw HTTP responses.
    console.log(JSON.stringify({ ok: false, error: { code: 'CHROME_ATTACH_FAILED', message: '连接现有 Chrome 失败；请确认助播台运行、调试已开启，并在 Chrome 中允许连接。' } }))
    process.exitCode = 1
  })
}
