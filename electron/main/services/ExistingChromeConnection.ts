import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  parseTikTokAttachPage, PlatformSessionError, type PlatformSessionState,
  validateBrowserAttachEndpoint,
} from '../../../shared/platformSession'

export function parseChromeDebugPort(raw: string): string {
  const lines=raw.trimEnd().split(/\r?\n/)
  if(raw.length>1024 || lines.length!==2 || !/^\d{1,5}$/.test(lines[0]) || Number(lines[0])<1 || Number(lines[0])>65535 || !/^\/devtools\/browser\/[A-Za-z0-9_-]{1,256}$/.test(lines[1]))
    throw new PlatformSessionError('CHROME_DEBUG_INVALID','Chrome 调试连接未就绪，请在已登录 Chrome 中检查远程调试设置')
  return validateBrowserAttachEndpoint(`ws://127.0.0.1:${Number(lines[0])}${lines[1]}`)
}

/** Reads only Chrome's local debugging descriptor; no cookies or credentials. */
export async function discoverExistingChromeEndpoint(profileDirectory?: string): Promise<string> {
  const local=process.env.LOCALAPPDATA
  if(!profileDirectory&&!local)throw new PlatformSessionError('CHROME_DEBUG_NOT_ENABLED','尚未发现 Chrome 调试连接，请在已登录 Chrome 中启用远程调试')
  const file=join(profileDirectory??join(local!,'Google','Chrome','User Data'),'DevToolsActivePort')
  try {
    const stat=await lstat(file)
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024)throw new PlatformSessionError('CHROME_DEBUG_INVALID','Chrome 调试连接未就绪，请检查远程调试设置')
    return parseChromeDebugPort(await readFile(file,'utf8'))
  } catch(error) {
    if(error instanceof PlatformSessionError)throw error
    if((error as NodeJS.ErrnoException).code==='ENOENT')throw new PlatformSessionError('CHROME_DEBUG_NOT_ENABLED','请在已登录 Chrome 打开 chrome://inspect/#remote-debugging，启用远程调试后再连接')
    throw new PlatformSessionError('CHROME_DEBUG_INVALID','无法读取 Chrome 调试连接，请检查远程调试设置')
  }
}

type Session={getPlatformSessionState():Promise<PlatformSessionState>;attachBrowser(endpoint:string,pageUrl:string):Promise<PlatformSessionState>}
export async function attachExistingChrome(session:Session,pageUrl:string,discover=discoverExistingChromeEndpoint):Promise<PlatformSessionState> {
  const target=parseTikTokAttachPage(pageUrl)
  const state=await session.getPlatformSessionState()
  if(state.browserOpen) {
    if(state.loginStatus==='authenticated'&&state.roomReady&&state.target?.url===target.url)return state
    throw new PlatformSessionError('SESSION_BUSY','账号已有浏览器，请先停止采集；已有连接请使用“应用直播间”，独立登录窗口请关闭后再接入 Chrome')
  }
  return session.attachBrowser(await discover(),target.url)
}
