import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * 按倍速把一段 WAV 重做一份，**变速不变调**。
 *
 * ## 为什么需要它
 *
 * 系统原来按 `时长 = 0.198 × 字数 + 0.45` 估时长、据此裁文本。实测这个模型是坏的：
 * 同样 9 个字可以是 1.76 秒也可以是 4.24 秒（**差 2.4 倍**），因为千问的输出
 * 按 0.08 秒量化（模型是 12Hz），而且一个逗号就值 1.04 秒 —— **字数根本不是时长的函数**。
 *
 * 而合成是**确定性**的（同一句合 6 遍，一个采样都不差），所以时长**量得出来**。
 * 量出来装不下时，正确做法是**调速**而不是裁内容：
 *
 * ```
 * 那句话 4.24 秒，能放 4.12 秒  →  atempo 1.03×  →  快 3%，听不出来，一个字不丢
 * ```
 *
 * 用 ffmpeg 的 `atempo` 滤镜：它**只改速度、不改音高**（不是简单的重采样）。
 * 倍速范围 0.5~2.0；本项目的策略是封顶 1.25×（再高就像快进，宁可去裁文本）。
 */
export class SpeechRetimer {
  constructor(
    private ffmpeg: string,
    /** 探时长用。不传就从 ffmpeg 路径推。 */
    private ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m, e) => `ffprobe${e || ''}`),
  ) {}

  async duration(file: string): Promise<number> {
    const { stdout } = await run(
      this.ffprobe,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { windowsHide: true },
    )
    return Number(String(stdout).trim())
  }

  /**
   * 生成一份倍速为 `speed` 的新文件，放在 `outDir`。
   *
   * `speed` 落在 1.0 附近就**直接返回原文件**（不白跑一次子进程）；
   * 超出 atempo 能做的范围就夹住 —— 与其让 ffmpeg 报错，不如给个能用的结果。
   */
  async retime(
    file: string,
    speed: number,
    outDir: string,
  ): Promise<{ file: string; duration: number; speed: number }> {
    if (!Number.isFinite(speed) || speed <= 0)
      throw new Error(`倍速不合法：${speed}`)
    const clamped = Math.min(2, Math.max(0.5, speed))
    if (Math.abs(clamped - 1) < 0.0001) return { file, duration: await this.duration(file), speed: 1 }

    await mkdir(outDir, { recursive: true })
    const out = join(outDir, `${Date.now()}-${Math.round(clamped * 1000)}x.wav`)
    await run(
      this.ffmpeg,
      ['-y', '-hide_banner', '-v', 'error', '-i', file, '-af', `atempo=${clamped}`, out],
      { windowsHide: true },
    )
    if (!existsSync(out)) throw new Error('调速后没有生成文件')
    return { file: out, duration: await this.duration(out), speed: clamped }
  }
}
