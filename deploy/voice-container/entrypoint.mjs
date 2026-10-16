import http from 'node:http'

// Only the container namespace can reach this secure-context localhost fixture.
http.createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><title>OBA isolated audio probe</title><p>Container virtual microphone fixture. No host device is mounted.</p>')
}).listen(8891, '127.0.0.1')

let ready = false
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await fetch('http://127.0.0.1:9223/json/version', { signal: AbortSignal.timeout(1500) })
    if (response.ok) { ready = true; break }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 1000))
}
if (!ready) throw new Error('Isolated container Chromium CDP did not become ready')
await import('./vendor/doubao_ctl.mjs')
