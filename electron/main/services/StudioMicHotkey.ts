import { execFile } from 'node:child_process'
import path from 'node:path'
import type { StudioMicHotkeyCommand, StudioMicHotkeyResult } from '../../../shared/studioMicHotkey'

const HOTKEY = 'Control+Option+M'
const COOLDOWN_MS = 1200
type HelperOptions = { timeout: number; maxBuffer: number }
type HelperExec = (
  file: string,
  args: string[],
  options: HelperOptions,
) => Promise<{ stdout: string; stderr?: string }>

interface StudioMicHotkeyOptions {
  platform?: string
  helperPath?: string
  exec?: HelperExec
  now?: () => number
}

function failure(code: string, message: string): StudioMicHotkeyResult {
  return { ok: false, error: { code, message } }
}

const executeHelper: HelperExec = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { ...options, encoding: 'utf8', windowsHide: true, shell: false },
      (error, stdout, stderr) => {
        if (error) reject(error)
        else resolve({ stdout, stderr })
      },
    )
  })

function isCommand(command: unknown): command is StudioMicHotkeyCommand {
  if (!command || typeof command !== 'object' || Array.isArray(command)) return false
  const keys = Object.keys(command)
  const action = (command as Record<string, unknown>).action
  return (
    keys.length === 1 &&
    keys[0] === 'action' &&
    (action === 'status' || action === 'request-access' || action === 'toggle')
  )
}

function parseHelperResult(
  stdout: string,
  action: StudioMicHotkeyCommand['action'],
): StudioMicHotkeyResult {
  const invalid = () =>
    failure('STUDIO_MIC_INVALID_RESPONSE', '麦克风热键助手未返回有效结果，请重新检查状态。')
  let result: unknown
  try {
    result = JSON.parse(stdout)
  } catch {
    return invalid()
  }
  if (!result || typeof result !== 'object') return invalid()
  const value = result as Record<string, unknown>
  if (value.ok === false) {
    if (!value.error || typeof value.error !== 'object') return invalid()
    const error = value.error as Record<string, unknown>
    if (
      typeof error.code !== 'string' ||
      !/^STUDIO_MIC_[A-Z_]+$/.test(error.code) ||
      typeof error.message !== 'string' ||
      !error.message ||
      error.message.length > 1000
    )
      return invalid()
    return failure(error.code, error.message)
  }
  if (value.ok !== true || !value.data || typeof value.data !== 'object') return invalid()
  const data = value.data as Record<string, unknown>
  if (
    data.supported !== true ||
    typeof data.running !== 'boolean' ||
    typeof data.accessGranted !== 'boolean' ||
    data.hotkey !== HOTKEY ||
    data.micState !== 'unknown' ||
    typeof data.message !== 'string' ||
    data.message.length > 1000 ||
    (data.sent !== undefined && typeof data.sent !== 'boolean')
  )
    return invalid()
  if (
    action === 'toggle'
      ? data.sent !== true || !data.running || !data.accessGranted
      : data.sent === true
  )
    return invalid()
  return {
    ok: true,
    data: {
      supported: true,
      running: data.running,
      accessGranted: data.accessGranted,
      hotkey: HOTKEY,
      micState: 'unknown',
      ...(data.sent === undefined ? {} : { sent: data.sent }),
      message: data.message,
    },
  }
}

/** Sends one fixed Studio hotkey. Event delivery cannot establish the broadcast's mute state. */
export class StudioMicHotkey {
  private readonly options: StudioMicHotkeyOptions
  private readonly exec: HelperExec
  private readonly now: () => number
  private toggling = false
  private lastToggleFinishedAt: number | undefined

  constructor(options: StudioMicHotkeyOptions = {}) {
    this.options = options
    this.exec = options.exec ?? executeHelper
    this.now = options.now ?? Date.now
  }

  async execute(command: unknown): Promise<StudioMicHotkeyResult> {
    if (!isCommand(command))
      return failure('STUDIO_MIC_INVALID_COMMAND', '不支持的麦克风热键请求。')
    if ((this.options.platform ?? process.platform) !== 'darwin') {
      if (command.action !== 'status')
        return failure('STUDIO_MIC_UNSUPPORTED_PLATFORM', '此麦克风热键助手当前仅支持 macOS。')
      return {
        ok: true,
        data: {
          supported: false,
          running: false,
          accessGranted: false,
          hotkey: HOTKEY,
          micState: 'unknown',
          message: '此麦克风热键助手当前仅支持 macOS。',
        },
      }
    }
    const helperPath = this.options.helperPath
    if (!helperPath || !path.isAbsolute(helperPath))
      return failure(
        'STUDIO_MIC_HELPER_UNAVAILABLE',
        '未找到麦克风热键助手，请安装完整的 Mac 桌面版。',
      )
    const toggle = command.action === 'toggle'
    if (toggle) {
      if (this.toggling)
        return failure('STUDIO_MIC_BUSY', '正在发送麦克风热键，请等待本次操作结束。')
      if (
        this.lastToggleFinishedAt !== undefined &&
        this.now() - this.lastToggleFinishedAt < COOLDOWN_MS
      )
        return failure('STUDIO_MIC_COOLDOWN', '操作太快，请稍后再切换麦克风。')
      this.toggling = true
    }
    try {
      const { stdout } = await this.exec(helperPath, [`--${command.action}`], {
        timeout: 8000,
        maxBuffer: 65536,
      })
      return parseHelperResult(stdout, command.action)
    } catch (error) {
      const detail = error && typeof error === 'object' ? (error as Record<string, unknown>) : {}
      if (detail.code === 'ENOENT' || detail.code === 'EACCES')
        return failure(
          'STUDIO_MIC_HELPER_UNAVAILABLE',
          '麦克风热键助手缺失或无法运行，请安装完整的 Mac 桌面版。',
        )
      if (detail.code === 'ETIMEDOUT' || detail.killed === true)
        return failure(
          'STUDIO_MIC_TIMEOUT',
          '麦克风热键操作超时，请先在 TikTok LIVE Studio 中确认当前麦克风状态。',
        )
      return failure(
        'STUDIO_MIC_HELPER_FAILED',
        '麦克风热键助手运行失败，请先在 TikTok LIVE Studio 中确认当前麦克风状态。',
      )
    } finally {
      if (toggle) {
        this.lastToggleFinishedAt = this.now()
        this.toggling = false
      }
    }
  }
}
