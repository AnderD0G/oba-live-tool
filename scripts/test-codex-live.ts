import { PersistentCodexDraftService } from '../electron/main/services/PersistentCodexDraftService'

const service = new PersistentCodexDraftService()
try {
  const started = Date.now()
  const initial = await service.status()
  console.log({ status: initial, startupMs: Date.now() - started })
  if (!initial.available) throw new Error(initial.error)
  for (const [index, comment] of [
    '你好呀',
    '主播，你用什么软件把手机画面传到电脑的？',
    '手机用什么软件呀？',
  ].entries()) {
    const result = await service.generate(1, {
      requestId: `synthetic-smoke-${index}`,
      comment,
      instructions:
        '已知信息：手机使用 Moblin，经云服务器 SRT 中转到 Windows OBS。请用中文 60 字以内友好回答。',
    })
    const current = await service.status()
    console.log({ index, result, samePid: current.available && current.pid === initial.pid })
    if (!result.ok) {
      process.exitCode = 1
      break
    }
  }
} finally {
  service.dispose()
}
