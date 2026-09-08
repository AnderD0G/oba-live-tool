import { CodexDraftService } from '../electron/main/services/CodexDraftService'

const service = new CodexDraftService()
console.log(await service.status())
const result = await service.generate(1, {
  requestId: 'synthetic-smoke-test',
  comment: '主播，你用什么软件把手机画面传到电脑的？',
  instructions:
    '已知信息：手机使用 Moblin，经云服务器 SRT 中转到 Windows OBS。请用中文 60 字以内友好回答。',
})
console.log(result)
if (!result.ok) process.exitCode = 1
