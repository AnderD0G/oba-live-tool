import { createHash } from 'node:crypto'
import { validateDeepSeekAutoSettings, type DeepSeekAutoSettings } from '../../../shared/deepSeekAuto'

type Backend = NonNullable<DeepSeekAutoSettings['voiceBackend']>
export interface LiveVoiceConfigDependencies {
  known(accountId: string): boolean
  read(accountId: string): DeepSeekAutoSettings
  /** Raw saved fields, before runtime defaults/model-alias normalization. */
  readStored?(accountId: string): DeepSeekAutoSettings
  save(accountId: string, settings: DeepSeekAutoSettings): void
  enabled(accountId: string): boolean
  starting(): boolean
  status(backend: Backend): unknown
  check(accountId: string): Promise<string>
}

export class LiveVoiceConfigError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

export function liveVoiceSettingsRevision(settings: DeepSeekAutoSettings) {
  return createHash('sha256').update(JSON.stringify(settings)).digest('hex')
}

/** One writer: API patches go through the same guarded save as native IPC. Never starts live. */
export class LiveVoiceConfiguration {
  constructor(private readonly deps: LiveVoiceConfigDependencies) {}

  revision(accountId: string) {
    this.requireAccount(accountId)
    return liveVoiceSettingsRevision(this.stored(accountId))
  }

  snapshot(accountId: string) {
    this.requireAccount(accountId)
    const settings = this.deps.read(accountId)
    const config = {
      voiceBackend: settings.voiceBackend ?? 'qwen',
      voicePlayback: settings.voicePlayback ?? 'conversation',
      streamingPlayback: settings.streamingPlayback !== false,
    }
    return {
      accountId, revision: this.revision(accountId), config,
      enabled: this.deps.enabled(accountId), starting: this.deps.starting(),
      voiceService: this.deps.status(config.voiceBackend),
    }
  }

  apply(accountId: string, revision: unknown, patch: unknown) {
    this.requireAccount(accountId)
    if (this.deps.starting() || this.deps.enabled(accountId))
      throw new LiveVoiceConfigError('请先关闭自动回复；启动中不能修改语音配置', 409)
    if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision))
      throw new LiveVoiceConfigError('revision 无效，请先读取语音配置')
    if (revision !== this.revision(accountId))
      throw new LiveVoiceConfigError('配置版本已改变，请重新读取并合并', 409)
    if (!patch || typeof patch !== 'object' || Array.isArray(patch))
      throw new LiveVoiceConfigError('patch 必须是非空语音配置对象')
    const keys = Object.keys(patch)
    if (!keys.length || keys.some(key => !['voiceBackend', 'voicePlayback', 'streamingPlayback'].includes(key)))
      throw new LiveVoiceConfigError('只允许修改 voiceBackend、voicePlayback、streamingPlayback')
    // Explicit undefined is invalid too; JSON cannot carry it, but native callers can.
    if (keys.some(key => (patch as Record<string, unknown>)[key] === undefined))
      throw new LiveVoiceConfigError('语音配置值不能为空')
    const next = { ...this.stored(accountId), ...patch }
    validateDeepSeekAutoSettings(next)
    this.deps.save(accountId, next)
    return this.snapshot(accountId)
  }

  async check(accountId: string) {
    const revision = this.revision(accountId)
    const message = await this.deps.check(accountId)
    if (this.revision(accountId) !== revision)
      throw new LiveVoiceConfigError('检查期间配置已改变，请重新检查', 409)
    return { ...this.snapshot(accountId), message }
  }

  private requireAccount(accountId: string) {
    if (typeof accountId !== 'string' || !accountId.trim() || accountId.length > 200 || !this.deps.known(accountId))
      throw new LiveVoiceConfigError('账号不存在，请先发现实际账号')
  }

  private stored(accountId: string) { return this.deps.readStored?.(accountId) ?? this.deps.read(accountId) }
}

/** Lazy factories: selecting Index must never construct/start the Qwen service. */
export function selectedVoiceClient<T>(backend: Backend | undefined, index: () => T, qwen: () => T): T {
  if (backend === 'index25') return index()
  if (backend === 'legacy') throw new Error('旧语音台不支持此试听，请选择 Index2.5 或千问')
  return qwen()
}

export function selectedAccountVoiceClient<T>(accountId: unknown, index: () => T, qwen: () => T): T {
  if (typeof accountId !== 'string' || !accountId.trim()) throw new LiveVoiceConfigError('请明确指定当前试听账号')
  return selectedVoiceClient(getLiveVoiceConfiguration().snapshot(accountId).config.voiceBackend, index, qwen)
}

let current: LiveVoiceConfiguration | undefined
export function setLiveVoiceConfiguration(api: LiveVoiceConfiguration) { current = api }
export function getLiveVoiceConfiguration() {
  if (!current) throw new LiveVoiceConfigError('语音配置尚未初始化', 503)
  return current
}
