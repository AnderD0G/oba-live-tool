import { setTimeout as delay } from 'node:timers/promises'
import type { DirectorSpeechQueue, ReadySpeech } from './DirectorSpeechQueue'
import { type ObsRpcClient, ObsWebSocketClient } from './ObsWebSocketClient'
import { waitForPausedStream, waitForSpeechPlayback } from './StreamingPlayback'

/** Standalone spoken dialogue, independent of prerecorded material or approved speech slots. */
export class ConversationVoiceOutput {
  static readonly inputName = 'OBA 实时语音对话'
  private controller = new AbortController()
  private task?: Promise<void>
  private scene = ''
  private itemId = 0
  private file = ''
  private state: 'idle' | 'ready' | 'playing' | 'error' = 'idle'
  private error = ''
  constructor(
    private settings: { url: string; password: string },
    private queue: DirectorSpeechQueue,
    private log: (message: string) => void = () => {},
    private client: ObsRpcClient = new ObsWebSocketClient(),
  ) {}
  get snapshot() {
    return { state: this.state, error: this.error, scene: this.scene }
  }
  private call(type: string, data: Record<string, unknown> = {}) {
    return this.client.call(type, { inputName: ConversationVoiceOutput.inputName, ...data })
  }
  private visible(enabled: boolean) {
    return this.client.call('SetSceneItemEnabled', {
      sceneName: this.scene,
      sceneItemId: this.itemId,
      sceneItemEnabled: enabled,
    })
  }
  async start() {
    try {
      await this.client.connect(this.settings.url, this.settings.password)
      const current = await this.client.call('GetCurrentProgramScene')
      this.scene = String(current.currentProgramSceneName || '')
      if (!this.scene) throw new Error('OBS 当前没有直播场景')
      const list = await this.client.call('GetInputList')
      const existing = (list.inputs as { inputName: string; inputKind: string }[]).find(
        i => i.inputName === ConversationVoiceOutput.inputName,
      )
      if (existing && existing.inputKind !== 'ffmpeg_source')
        throw new Error('实时语音来源名称已被其他类型占用')
      if (existing) {
        // Silence before attaching/reusing an existing source; never replay its previous file.
        await this.call('SetInputMute', { inputMuted: true })
        await this.call('TriggerMediaInputAction', {
          mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
        })
        try {
          this.itemId = Number(
            (
              await this.client.call('GetSceneItemId', {
                sceneName: this.scene,
                sourceName: ConversationVoiceOutput.inputName,
              })
            ).sceneItemId,
          )
        } catch {
          this.itemId = Number(
            (
              await this.client.call('CreateSceneItem', {
                sceneName: this.scene,
                sourceName: ConversationVoiceOutput.inputName,
                sceneItemEnabled: false,
              })
            ).sceneItemId,
          )
        }
      } else
        this.itemId = Number(
          (
            await this.client.call('CreateInput', {
              sceneName: this.scene,
              inputName: ConversationVoiceOutput.inputName,
              inputKind: 'ffmpeg_source',
              inputSettings: {
                is_local_file: true,
                local_file: '',
                looping: false,
                restart_on_activate: false,
                close_when_inactive: false,
              },
              sceneItemEnabled: false,
            })
          ).sceneItemId,
        )
      await this.call('SetInputMute', { inputMuted: true })
      await this.visible(false)
      await this.call('SetInputAudioMonitorType', {
        monitorType: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
      })
      this.controller.signal.throwIfAborted()
      this.state = 'ready'
      this.task = this.run()
    } catch (error) {
      this.state = 'error'
      this.error = error instanceof Error ? error.message : 'OBS 语音连接失败'
      await this.client.disconnect()
      throw error
    }
  }
  private async run() {
    const signal = this.controller.signal
    while (!signal.aborted) {
      const reply = this.queue.takeNext()
      if (!reply) {
        try {
          await delay(50, undefined, { signal })
        } catch {}
        continue
      }
      let status: 'played' | 'expired' | 'failed' = 'failed'
      try {
        status = await this.play(reply)
        this.error = ''
      } catch (error) {
        if (!signal.aborted) {
          this.error = error instanceof Error ? error.message : '语音播放失败'
          this.log(this.error)
        }
      } finally {
        await this.call('SetInputMute', { inputMuted: true }).catch(() => {})
        if (reply.streaming) await this.call('TriggerMediaInputAction', {
          mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
        }).catch(() => {})
        await this.visible(false).catch(() => {})
        reply.done?.(status)
        this.state = signal.aborted ? 'idle' : this.error ? 'error' : 'ready'
      }
    }
  }
  private async play(reply: ReadySpeech): Promise<'played' | 'expired'> {
    const signal = this.controller.signal
    if (reply.streaming) reply.file = await reply.streaming.prepare(19.4)
    const remote = /^http:\/\/127\.0\.0\.1:\d+\//.test(reply.file)
    await this.call('SetInputMute', { inputMuted: true })
    await this.visible(true)
    if (this.file === reply.file)
      await this.call('TriggerMediaInputAction', {
        mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
      })
    else {
      await this.call('SetInputSettings', {
        inputSettings: {
          is_local_file: !remote,
          ...(remote ? { input: reply.file, input_format: 'mp3', ffmpeg_options: 'probesize=32 analyzeduration=0', buffering_mb: 0, clear_on_media_end: false }
            : { local_file: reply.file, input_format: '', ffmpeg_options: '' }),
          looping: false,
          restart_on_activate: false,
          close_when_inactive: false,
        },
        overlay: true,
      })
      this.file = reply.file
    }
    const loading = Date.now()
    let loaded = false
    if (reply.streaming) {
      await waitForPausedStream(() => this.call('TriggerMediaInputAction', {
        mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE',
      }), () => this.call('GetMediaInputStatus'), signal, reply.streaming)
      loaded = true
    }
    while (!loaded && Date.now() - loading < 5000) {
      signal.throwIfAborted()
      reply.streaming?.check()
      const s = await this.call('GetMediaInputStatus')
      if (s.mediaState === 'OBS_MEDIA_STATE_ERROR') throw new Error('OBS 无法解码互动语音')
      if (
        s.mediaState === 'OBS_MEDIA_STATE_PLAYING' &&
        (remote || Math.abs(Number(s.mediaDuration) / 1000 - reply.duration) < 0.25)
      ) {
        loaded = true
        break
      }
      await delay(20, undefined, { signal })
    }
    if (!loaded) throw new Error('OBS 互动语音载入超时')
    if (!reply.streaming) {
      await this.call('TriggerMediaInputAction', {
        mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE',
      })
      await this.call('SetMediaInputCursor', { mediaCursor: 0 })
    }
    if (!reply.valid() || reply.expiresAt <= Date.now()) return 'expired'
    reply.streaming?.check()
    // Do not speak into an invisible scene after the operator changes program.
    const current = await this.client.call('GetCurrentProgramScene')
    if (current.currentProgramSceneName !== this.scene)
      throw new Error('OBS 已切换场景，请重新开启语音对话以连接当前场景')
    await this.call('SetInputMute', { inputMuted: false })
    signal.throwIfAborted()
    if (!reply.valid() || reply.expiresAt <= Date.now()) return 'expired'
    const streamDeadline = Date.now() + 20000
    reply.streaming?.start(streamDeadline)
    await this.call('TriggerMediaInputAction', {
      mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY',
    })
    this.state = 'playing'
    if (reply.streaming) {
      await waitForSpeechPlayback(reply.streaming, () => this.call('GetMediaInputStatus'), signal, streamDeadline)
      this.log(`语音已播放：${reply.text}`)
      return 'played'
    }
    const started = Date.now()
    while (Date.now() - started < (reply.duration + 15) * 1000) {
      await delay(20, undefined, { signal })
      const state = await this.call('GetMediaInputStatus').catch(() => undefined)
      if (state?.mediaState === 'OBS_MEDIA_STATE_ENDED') {
        this.log(`语音已播放：${reply.text}`)
        return 'played'
      }
      if (state?.mediaState === 'OBS_MEDIA_STATE_ERROR') throw new Error('互动语音播放失败')
    }
    throw new Error('OBS 未确认语音播放结束')
  }
  async stop() {
    this.controller.abort()
    this.queue.clear()
    await this.call('SetInputMute', { inputMuted: true }).catch(() => {})
    await this.call('TriggerMediaInputAction', {
      mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
    }).catch(() => {})
    if (this.scene) await this.visible(false).catch(() => {})
    await this.task
    await this.client.disconnect()
    this.state = 'idle'
  }
}
