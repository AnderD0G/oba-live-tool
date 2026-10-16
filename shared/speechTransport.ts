/**
 * 语音走哪条通道产出。
 *
 * ## 为什么要把这三行单独拎出来
 *
 * 2026-09-29 真机翻车：虚拟声卡明明就绪，观众却什么都听不到。
 * 根因是这条规则当时**内联在 `deepSeekAuto.ts` 的一个对象字面量里**，
 * 没法单测，也没人看得出它和生产实际走的路对不上：
 *
 *   · 流式播放产出的是 `http://127.0.0.1/...` 的 MP3 流地址，**磁盘上没有文件**；
 *   · 虚拟声卡那条路要把**文件**交给播放服务去渲染。
 *
 * 两者天生互斥，而 `streamingPlayback` 默认是开的 —— 于是虚拟声卡永远轮不上。
 * 现在这条规则是一个纯函数，有单测钉住，改坏了会立刻红。
 */
export type SpeechTransport = 'stream' | 'file'

export function speechTransportFor(input: {
  voiceBackend?: 'index25' | 'qwen' | 'legacy'
  /** 界面上的「流式播放」。`undefined` 按开处理（默认开）。 */
  streamingPlayback?: boolean
  /** 虚拟声卡开关（`virtual-cable.json` 的 `enabled`）。 */
  virtualCableEnabled: boolean
  /** 播放目标。只有导播会走虚拟声卡。 */
  voicePlayback?: 'conversation' | 'director'
}): SpeechTransport {
  // 用户显式关掉流式 —— 最优先，没有商量余地。
  if (input.streamingPlayback === false) return 'file'
  // Index supplies an adaptive PCM buffer and uses the OBS network source; it does not
  // hand a growing WAV to the file-only cable player.
  if (input.voiceBackend === 'index25') return 'stream'
  /**
   * 虚拟声卡开着、而且音频是要交给导播去插气口的 —— **必须给文件**。
   *
   * 只看 `voicePlayback === 'director'`：独立语音对话那条路
   * （`ConversationVoiceOutput`）根本不走虚拟声卡，为它关掉流式只会白慢 0.5 秒。
   */
  if (input.virtualCableEnabled && input.voicePlayback === 'director') return 'file'
  return 'stream'
}
