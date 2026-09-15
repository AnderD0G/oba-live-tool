import path from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { IPC_CHANNELS } from '../../../shared/ipcChannels'
import type { SetupResult, SetupStatus } from '../../../shared/setup'
import { configureBundledCodex, detectCodex } from '../services/CodexRuntime'
import type { PersistentCodexDraftService } from '../services/PersistentCodexDraftService'
import { findChromium } from '../utils/checkChrome'
import { typedIpcMainHandle } from '../utils/ipc'

export function setupEnvironmentIpc(service: PersistentCodexDraftService) {
  const root = app.isPackaged
    ? path.join(process.resourcesPath, 'codex')
    : path.join(app.getAppPath(), 'vendor-build/codex/package')
  configureBundledCodex(path.join(root, 'vendor/x86_64-pc-windows-msvc/bin/codex.exe'))
  let loginId: string | undefined
  let loginStarting = false
  typedIpcMainHandle(IPC_CHANNELS.setup.request, async (event, action): Promise<SetupResult> => {
    try {
      switch (action) {
        case 'status': {
          const status: SetupStatus = {
            version: app.getVersion(),
            system: `${process.platform} / ${process.arch}`,
            browser: '',
            codex: { available: false },
            printers: [],
          }
          await Promise.all([
            findChromium()
              .then(browser => {
                status.browser = browser
              })
              .catch(() => {
                status.browserError = '未找到 Edge 或 Chrome。请安装浏览器后重新检测。'
              }),
            (async () => {
              try {
                const runtime = await detectCodex()
                status.codex = {
                  available: true,
                  version: runtime.version,
                  bundled: runtime.bundled,
                }
                status.codex.loggedIn = await service.accountReady()
              } catch (error) {
                status.codex.error = error instanceof Error ? error.message : '检查登录失败'
              }
            })(),
            (async () => {
              try {
                const window = BrowserWindow.fromWebContents(event.sender)
                if (!window) throw new Error('窗口已关闭')
                status.printers = (await window.webContents.getPrintersAsync()).map(
                  printer => printer.name,
                )
              } catch {
                status.printerError = '无法读取打印机，请检查 Windows 打印服务。'
              }
            })(),
          ])
          return { ok: true, status }
        }
        case 'login': {
          if (loginStarting) throw new Error('正在打开登录页面，请稍候')
          if (service.isBusy) throw new Error('请等待当前 AI 回复完成后再登录')
          loginStarting = true
          try {
            if (loginId) await service.cancelLogin(loginId)
            const result = await service.startLogin()
            loginId = result.loginId
            const url = new URL(result.authUrl)
            if (
              url.protocol !== 'https:' ||
              !['auth.openai.com', 'chatgpt.com', 'auth0.openai.com'].includes(url.hostname)
            ) {
              await service.cancelLogin(result.loginId)
              throw new Error('登录地址校验失败')
            }
            await shell.openExternal(url.toString())
            return {
              ok: true,
              message: '请在浏览器里完成 ChatGPT 登录，然后点击“重新检测”。登录不会生成回复。',
            }
          } finally {
            loginStarting = false
          }
        }
        case 'cancelLogin':
          if (loginId) await service.cancelLogin(loginId)
          loginId = undefined
          return { ok: true, message: '已取消本次登录。' }
        case 'printers':
          await shell.openExternal('ms-settings:printers')
          return { ok: true, message: '请在 Windows 中添加打印机或安装厂商驱动，再回来重新检测。' }
        case 'browserDownload':
          await shell.openExternal('https://www.microsoft.com/edge/download')
          return { ok: true, message: '已打开 Edge 官方下载页面，安装后请重新检测。' }
        default:
          throw new Error('无效操作')
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '操作失败' }
    }
  })
}
