import WS from './vendor/node_modules/ws/index.js'
import { audioProbeExpression, isForwardedTone } from './probe-tools.mjs'

const audio = process.argv.includes('--audio')
const response = await fetch('http://127.0.0.1:7799/api', { signal: AbortSignal.timeout(5000) })
if (!response.ok || !(await response.text()).includes('/api/rec/cancel')) throw new Error('Voice self-description is unavailable')
const version = await (await fetch('http://127.0.0.1:9223/json/version', { signal: AbortSignal.timeout(5000) })).json()
const ws = new WS(version.webSocketDebuggerUrl, { handshakeTimeout: 10000 })
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
let counter = 0
const pending = new Map()
ws.on('message', raw => {
  const message = JSON.parse(raw.toString())
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  clearTimeout(request.timer)
  message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result)
})
function send(method, params = {}, sessionId) {
  const id = ++counter
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 15000)
    pending.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ id, method, params, sessionId }))
  })
}
let targetId
let browserContextId
try {
  ;({ browserContextId } = await send('Target.createBrowserContext'))
  ;({ targetId } = await send('Target.createTarget', { url: 'http://127.0.0.1:8891/audio-probe.html', background: true, browserContextId }))
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Runtime.enable', {}, sessionId)
  await new Promise(resolve => setTimeout(resolve, 500))
  const page = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId)
  if (page.result?.value !== 'OBA isolated audio probe') throw new Error('Isolated fixture did not load')
  const result = { httpApi: true, cdp: true, pageLoaded: true, browser: version.Browser, audioTested: false }
  if (audio) {
    await send('Browser.grantPermissions', { origin: 'http://127.0.0.1:8891', permissions: ['audioCapture'], browserContextId })
    const measured = await send('Runtime.evaluate', { expression: audioProbeExpression(), returnByValue: true, awaitPromise: true, userGesture: true }, sessionId)
    if (measured.exceptionDetails) throw new Error('Container virtual input could not be measured')
    result.audioTested = true
    result.audio = measured.result?.value
    result.forwardedTone = isForwardedTone(result.audio)
    console.log(JSON.stringify(result))
    if (!result.forwardedTone) process.exitCode = 1
  } else console.log(JSON.stringify(result))
} finally {
  if (targetId) await send('Target.closeTarget', { targetId }).catch(() => {})
  if (browserContextId) await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {})
  ws.close()
}
