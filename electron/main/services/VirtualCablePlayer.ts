import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * 虚拟声卡播放客户端。
 *
 * ## 为什么要有它
 *
 * OBS 媒体源加载一个语音文件要 **0.88 秒**（实测），这段是**串行的、藏不掉的** ——
 * 语音源必须等音频生成完才能加载。结果就是「找到气口瞬间切进去」做不到：
 * 必须提前 1.6 秒去取，等于把能用的气口范围缩小一截。
 *
 * 直接渲染到声卡只要 **8 毫秒**打开、**81 毫秒**第一块缓冲写下（实测），
 * 从 CABLE Output 出来再花 **76 毫秒**。所以音频一就绪就能立刻出声。
 *
 * ## 链路
 *
 * ```
 * 千问 PCM → 本服务 → CABLE Input → CABLE Output → OBS「音频输入采集」
 * ```
 *
 * 真 OBS 32.2.2 实测采到了：基线 −91 dB、有声 −21.1 dB（+69.9 dB）。
 */

const DEFAULT_PORT = 17895
const STARTUP_TIMEOUT_MS = 15000

export interface CablePlayResult {
  ok: boolean
  device?: string
  openMs?: number
  firstBlockMs?: number
  duration?: number
  error?: string
}

export class VirtualCablePlayer {
  private child?: ChildProcess
  private starting?: Promise<boolean>

  constructor(
    private python: string,
    private script: string,
    private port = DEFAULT_PORT,
    private deviceKeyword = 'CABLE Input',
  ) {}

  private get base() {
    return `http://127.0.0.1:${this.port}`
  }

  /** 服务在不在。 */
  async health(): Promise<{ ok: boolean; device?: string; playing?: boolean }> {
    try {
      const response = await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(1500) })
      if (!response.ok) return { ok: false }
      return (await response.json()) as { ok: boolean; device?: string; playing?: boolean }
    } catch {
      return { ok: false }
    }
  }

  /** 机器上有没有可用的虚拟声卡（服务起着、设备找得到）。 */
  async available() {
    const state = await this.health()
    return state.ok && Boolean(state.device)
  }

  /** 需要时把服务拉起来；返回是否可用。 */
  async ensureReady(): Promise<boolean> {
    if (await this.available()) return true
    if (!existsSync(this.python) || !existsSync(this.script)) return false
    this.starting ??= this.launch()
    return this.starting
  }

  private async launch(): Promise<boolean> {
    try {
      this.child = spawn(this.python, [this.script], {
        stdio: 'ignore',
        windowsHide: true,
        detached: false,
      })
      this.child.on('exit', () => {
        this.child = undefined
        this.starting = undefined
      })
    } catch {
      return false
    }
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (await this.available()) return true
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    return false
  }

  /**
   * 播一个 WAV 到虚拟声卡。
   *
   * 本机服务同步写完全部样本、排空设备后返回 stopped:false。
   * 不把只确认首块的旧响应当成播放完成；中途停止必须走失败反馈。
   */
  async play(path: string, timeoutMs = 30000): Promise<CablePlayResult> {
    if (!(await this.ensureReady())) return { ok: false, error: '虚拟声卡播放服务不可用' }
    try {
      const response = await fetch(`${this.base}/play`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, device: this.deviceKeyword }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const body = (await response.json()) as {
        ok?: boolean
        device?: string
        open_ms?: number
        first_block_ms?: number
        duration?: number
        stopped?: boolean
        error?: string
      }
      return {
        ok: response.ok && body.ok === true && body.stopped === false,
        device: body.device,
        openMs: body.open_ms,
        firstBlockMs: body.first_block_ms,
        duration: body.duration,
        error: body.error || (body.stopped === false ? undefined : '未确认完整播放或已被停止'),
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '播放失败' }
    }
  }

  async stop(): Promise<void> {
    try {
      await fetch(`${this.base}/stop`, { method: 'POST', signal: AbortSignal.timeout(2000) })
    } catch {
      // 服务不在了就算了
    }
  }

  /** 停服务并放开进程。 */
  dispose() {
    const child = this.child
    this.child = undefined
    this.starting = undefined
    try {
      child?.kill()
    } catch {
      // 已经退出了
    }
  }
}

/**
 * 这台机器上虚拟声卡的现成环境。
 *
 * Python 和 `sounddevice` 都在语音台的 venv 里（那边本来就有音频播放能力），
 * 不用再装一套。
 */
export const CABLE_DEFAULTS = {
  python:
    'C:\\Users\\luizs\\Documents\\Codex\\2026-09-06\\mac-iphone-android-windows-4k-tiktok-3\\work\\local-voice-studio\\.venv\\Scripts\\python.exe',
  script: 'C:\\Users\\luizs\\Desktop\\voice\\scripts\\oba_audio_player.py',
}

let singleton: VirtualCablePlayer | undefined

export function getVirtualCablePlayer() {
  singleton ??= new VirtualCablePlayer(CABLE_DEFAULTS.python, CABLE_DEFAULTS.script)
  return singleton
}

export function disposeVirtualCablePlayer() {
  singleton?.dispose()
  singleton = undefined
}
