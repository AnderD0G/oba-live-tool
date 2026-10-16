import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { extname, join } from 'node:path'
import type { DirectorConfig, DirectorStep } from '../../../shared/director'
import { narrationSegments, type SpeechWindow } from '../../../shared/directorNarration'

export async function runMediaCommand(
  exe: string,
  args: string[],
  signal: AbortSignal,
  captureStderr = false,
): Promise<string> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, shell: false, signal })
    let out = ''
    let error = ''
    child.stdout.on('data', chunk => {
      out = (out + chunk).slice(-100000)
    })
    child.stderr.on('data', chunk => {
      error = (error + chunk).slice(captureStderr ? -500000 : -3000)
    })
    child.on('error', reject)
    child.on('close', code =>
      code === 0
        ? resolve(captureStderr ? error : out)
        : reject(new Error(`素材处理失败 (${code})：${error.slice(-3000)}`)),
    )
  })
}
export class DirectorMedia {
  private durationCache = new Map<string, number>()
  constructor(
    private config: DirectorConfig,
    private cache: string,
  ) {}
  private outputSize() {
    return {
      width: this.config.canvasWidth || 1080,
      height: this.config.canvasHeight || 1920,
    }
  }
  private videoFilter() {
    const { width, height } = this.outputSize()
    return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`
  }
  async duration(file: string, signal: AbortSignal) {
    const metadata = await stat(file)
    const key = `${file}:${metadata.size}:${metadata.mtimeMs}`
    const cached = this.durationCache.get(key)
    if (cached !== undefined) return cached
    const raw = await runMediaCommand(
      this.config.ffprobe,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        file,
      ],
      signal,
    )
    const value = Number(raw.trim())
    if (!Number.isFinite(value) || value <= 0) throw new Error(`无法读取素材时长：${file}`)
    this.durationCache.set(key, value)
    return value
  }
  async compile(step: DirectorStep, audio: string | undefined, signal: AbortSignal) {
    const length = await this.duration(step.file, signal)
    const end = step.end || length
    if (step.start >= length || end > length + 0.05 || end <= step.start)
      throw new Error(`${step.name}：起止点超出视频范围`)
    const duration = end - step.start
    const audioDuration = audio ? await this.duration(audio, signal) : 0
    const overflow = Math.max(0, audioDuration - duration)
    const overflowMode = step.audioOverflow || 'continue'
    const holdLastFrame = overflow > 0.08 && overflowMode === 'hold'
    if (overflow > 0.08 && step.audioOverflow === 'strict')
      throw new Error(`${step.name}：配音长于视频片段，请缩短配音或扩大结束点`)
    const outputDuration = holdLastFrame ? audioDuration : duration
    const versions = await Promise.all(
      [step.file, ...(audio ? [audio] : [])].map(async file => {
        const s = await stat(file)
        return [file, s.size, s.mtimeMs]
      }),
    )
    const key = createHash('sha256')
      .update(
        JSON.stringify({
          versions,
          start: step.start,
          end,
          output: this.outputSize(),
          outputDuration,
          overflowMode,
          format: 4,
        }),
      )
      .digest('hex')
    await mkdir(this.cache, { recursive: true })
    const target = join(this.cache, `${key}.mp4`)
    if (!existsSync(target)) {
      const temp = join(this.cache, `${key}-${randomUUID()}.mp4`)
      const args = ['-v', 'error', '-y', '-ss', String(step.start), '-i', step.file]
      if (audio) args.push('-i', audio)
      args.push('-map', '0:v:0')
      if (audio) args.push('-map', '1:a:0', '-af', 'apad', '-c:a', 'aac', '-ar', '48000')
      else args.push('-an')
      const trimmedVideo = `trim=start=0:duration=${duration},setpts=PTS-STARTPTS,${this.videoFilter()}`
      const videoFilter = holdLastFrame
        ? `${trimmedVideo},tpad=stop_mode=clone:stop_duration=${overflow}`
        : trimmedVideo
      args.push(
        '-t',
        String(outputDuration),
        '-vf',
        videoFilter,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '18',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        temp,
      )
      try {
        await runMediaCommand(this.config.ffmpeg, args, signal)
        await rename(temp, target)
      } finally {
        await unlink(temp).catch(() => {})
      }
    }
    return { file: target, duration: outputDuration, held: holdLastFrame }
  }
  async narrationParts(audio: string, windows: SpeechWindow[], signal: AbortSignal) {
    const duration = await this.duration(audio, signal)
    const segments = narrationSegments(audio, duration, windows)
    if (segments.length === 1)
      return [{ file: audio, duration, replaceable: segments[0].replaceable }]
    const metadata = await stat(audio)
    await mkdir(this.cache, { recursive: true })
    const result: { file: string; duration: number; replaceable: boolean }[] = []
    for (const segment of segments) {
      const key = createHash('sha256')
        .update(
          JSON.stringify([
            audio,
            metadata.size,
            metadata.mtimeMs,
            segment.start,
            segment.end,
            'speech-pcm-v1',
          ]),
        )
        .digest('hex')
      const file = join(this.cache, `${key}.wav`)
      if (!existsSync(file)) {
        const temp = join(this.cache, `${key}-${randomUUID()}.wav`)
        try {
          await runMediaCommand(
            this.config.ffmpeg,
            [
              '-v',
              'error',
              '-y',
              '-ss',
              String(segment.start),
              '-i',
              audio,
              '-t',
              String(segment.end - segment.start),
              '-vn',
              '-c:a',
              'pcm_s16le',
              '-ar',
              '48000',
              temp,
            ],
            signal,
          )
          await rename(temp, file)
        } finally {
          await unlink(temp).catch(() => {})
        }
      }
      result.push({
        file,
        duration: await this.duration(file, signal),
        replaceable: segment.replaceable,
      })
    }
    return result
  }
  async normalize(file: string, signal: AbortSignal) {
    const metadata = await stat(file)
    const duration = await this.duration(file, signal)
    const key = createHash('sha256')
      .update(
        JSON.stringify({
          file,
          size: metadata.size,
          mtimeMs: metadata.mtimeMs,
          output: this.outputSize(),
          format: 1,
        }),
      )
      .digest('hex')
    await mkdir(this.cache, { recursive: true })
    const target = join(this.cache, `${key}.mp4`)
    if (!existsSync(target)) {
      const temp = join(this.cache, `${key}-${randomUUID()}.mp4`)
      try {
        await runMediaCommand(
          this.config.ffmpeg,
          [
            '-v',
            'error',
            '-y',
            '-i',
            file,
            '-map',
            '0:v:0',
            '-map',
            '0:a:0?',
            '-vf',
            this.videoFilter(),
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '18',
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            '-ar',
            '48000',
            '-movflags',
            '+faststart',
            temp,
          ],
          signal,
        )
        await rename(temp, target)
      } finally {
        await unlink(temp).catch(() => {})
      }
    }
    return { file: target, duration }
  }
}

/** Loopback-only, opaque capabilities; never exposes arbitrary filesystem paths over HTTP. */
export class DirectorPreviewServer {
  private server?: Server
  private files = new Map<string, string>()
  async url(file: string) {
    if (!(await stat(file)).isFile()) throw new Error('请选择一个本地文件')
    if (!this.server) {
      const server = createServer(async (req, res) => {
        const file = this.files.get((req.url || '').slice(1))
        if (!file || !['GET', 'HEAD'].includes(req.method || '')) {
          res.writeHead(404).end()
          return
        }
        try {
          const { size } = await stat(file)
          const mime: Record<string, string> = {
            '.mp4': 'video/mp4',
            '.webm': 'video/webm',
            '.mov': 'video/quicktime',
            '.mp3': 'audio/mpeg',
            '.wav': 'audio/wav',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
          }
          let start = 0
          let end = size - 1
          const range = req.headers.range
          if (range) {
            const match = /^bytes=(\d+)-(\d*)$/.exec(range)
            if (!match) {
              res.writeHead(416).end()
              return
            }
            start = Number(match[1])
            end = match[2] ? Math.min(Number(match[2]), end) : end
          }
          if (start > end || start >= size) {
            res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
            return
          }
          res.writeHead(range ? 206 : 200, {
            'Content-Type': mime[extname(file).toLowerCase()] || 'application/octet-stream',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
            'Content-Length': end - start + 1,
            ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
          })
          if (req.method === 'HEAD') {
            res.end()
            return
          }
          const stream = createReadStream(file, { start, end })
          stream.on('error', () => res.destroy())
          res.on('close', () => stream.destroy())
          stream.pipe(res)
        } catch {
          if (!res.headersSent) res.writeHead(404)
          res.end()
        }
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      this.server = server
    }
    if (this.files.size > 200) this.files.delete(this.files.keys().next().value!)
    const key = randomUUID()
    this.files.set(key, file)
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('预览服务不可用')
    return `http://127.0.0.1:${address.port}/${key}`
  }
  close() {
    this.server?.closeAllConnections()
    this.server?.close()
    this.files.clear()
  }
}
