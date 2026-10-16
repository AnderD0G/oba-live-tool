import { spawn } from 'node:child_process'

/** Pitch-preserving retime of a complete short PCM segment; never resample to change speed. */
export async function retimeStreamPcm(
  ffmpeg: string, pcm: Buffer, speed: number, sampleRate = 22050, signal?: AbortSignal,
): Promise<Buffer> {
  if (!Number.isFinite(speed) || speed < 1 || speed > 1.25) throw new Error('流式倍速必须为 1～1.25')
  if (!pcm.length || pcm.length % 2 || pcm.length > sampleRate * 2 * 20)
    throw new Error('流式音频数据无效')
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', String(sampleRate), '-ac', '1',
      '-i', 'pipe:0', '-af', `atempo=${speed.toFixed(6)}`, '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', 'pipe:1',
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let size = 0, errors = '', settled = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) { child.kill(); reject(error) }
      else resolve(Buffer.concat(chunks))
    }
    const abort = () => finish(signal?.reason ?? new Error('变速已取消'))
    const timer = setTimeout(() => finish(new Error('流式变速超时')), 5000)
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', finish)
    child.stdin.on('error', finish)
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > pcm.length + sampleRate * 2) finish(new Error('流式变速输出过大'))
      else chunks.push(chunk)
    })
    child.stderr.on('data', chunk => { errors = (errors + String(chunk)).slice(-1000) })
    child.on('close', code => finish(code === 0 && size ? undefined : new Error(`流式变速失败 (${code}) ${errors}`)))
    child.stdin.end(pcm)
  })
}
