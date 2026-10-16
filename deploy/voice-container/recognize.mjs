import { performance } from 'node:perf_hooks'

const phases = []
const cancel = process.argv.includes('--cancel')
async function call(path, method = 'POST') {
  const start = performance.now()
  const response = await fetch(`http://127.0.0.1:7799${path}`, { method, signal: AbortSignal.timeout(45000) })
  const result = await response.json()
  phases.push({ path, durationMs: Math.round(performance.now() - start), ok: result.ok, code: result.error })
  return result
}
let ownedRecording = false
try {
  const before = await call('/api/state', 'GET')
  if (before.recording || before.busy) throw new Error('Isolated service is already recording or busy; no takeover attempted')
  const permission = await call('/api/grantmic')
  if (!permission.ok || permission['当前权限'] !== 'granted') throw new Error('Doubao container origin microphone permission is not granted')
  ownedRecording = true
  const started = await call('/api/rec/start')
  if (!started.ok) throw new Error(`Controlled recording failed: ${started.error ?? 'unknown'}`)
  await new Promise(resolve => setTimeout(resolve, cancel ? 1200 : 8500))
  const stopped = await call(cancel ? '/api/rec/cancel' : '/api/rec/stop')
  const after = await call('/api/state', 'GET')
  ownedRecording = !!after.recording
  console.log(JSON.stringify({ input: 'isolated-browser-fake-file-known-speech', physicalMicrophoneUsed: false, action: cancel ? 'cancel' : 'stop', ok: stopped.ok, text: stopped.text ?? '', recordingAfter: after.recording, busyAfter: after.busy, phases }))
  if (!stopped.ok || after.recording) process.exitCode = 1
} finally {
  if (ownedRecording) {
    const cancelled = await call('/api/rec/cancel')
    console.log(JSON.stringify({ cleanup: 'cancel', ok: cancelled.ok, recording: cancelled.recording }))
    if (!cancelled.ok || cancelled.recording) process.exitCode = 1
  }
}
