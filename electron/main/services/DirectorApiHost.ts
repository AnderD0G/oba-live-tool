import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type DirectorApiFacade, DirectorApiServer } from './DirectorApiServer'

/**
 * 本地 API 的生命周期：
 * - 令牌稳定保存，避免每次重启都要改 MCP 端的配置；
 * - 端口默认 17892（可用 OBA_DIRECTOR_API_PORT 覆盖），被占用时退回随机端口；
 * - 把实际端口和令牌写进 director-api.json，MCP server 直接读这个文件。
 *
 * 只监听回环地址；令牌不写入仓库，也不进日志正文。
 */

export const DIRECTOR_API_FILE = 'director-api.json'
export const DEFAULT_DIRECTOR_API_PORT = 17892

export interface DirectorApiEndpointFile {
  url: string
  port: number
  token: string
  pid: number
  startedAt: string
}

interface Options {
  userDataDir: string
  facade: DirectorApiFacade
  log: (message: string) => void
  port?: number
  obsOverlayDirectory?: string
}

export class DirectorApiHost {
  private server?: DirectorApiServer
  private info?: DirectorApiEndpointFile
  private readonly file: string

  constructor(private readonly options: Options) {
    this.file = join(options.userDataDir, DIRECTOR_API_FILE)
  }

  get endpoint() {
    return this.info
  }

  private readOrCreateToken() {
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf-8')) as { token?: unknown }
        if (typeof parsed.token === 'string' && parsed.token.length >= 16) return parsed.token
      }
    } catch {
      // 文件损坏就重新生成，令牌只影响本机调用方
    }
    return randomBytes(24).toString('hex')
  }

  async start() {
    if (this.server) return this.info
    const token = this.readOrCreateToken()
    const preferred =
      this.options.port ?? Number(process.env.OBA_DIRECTOR_API_PORT) ?? DEFAULT_DIRECTOR_API_PORT
    const server = new DirectorApiServer({
      facade: this.options.facade,
      token,
      // 0 表示让系统分配临时端口；非法值退回默认端口
      port: Number.isInteger(preferred) && preferred >= 0 ? preferred : DEFAULT_DIRECTOR_API_PORT,
      log: this.options.log,
      obsOverlayDirectory: this.options.obsOverlayDirectory,
    })
    let port: number
    try {
      port = await server.listen()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.options.log(`导播 API 无法监听 ${preferred} 端口（${message}），改用随机端口`)
      const fallback = new DirectorApiServer({
        facade: this.options.facade,
        token,
        port: 0,
        log: this.options.log,
        obsOverlayDirectory: this.options.obsOverlayDirectory,
      })
      try {
        port = await fallback.listen()
        this.server = fallback
      } catch (fallbackError) {
        this.options.log(
          `导播 API 启动失败：${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        )
        return undefined
      }
      this.info = this.writeEndpoint(fallback.url, port, token)
      this.options.log(`导播 API 已启动：${fallback.url}（随机端口）`)
      return this.info
    }
    this.server = server
    this.info = this.writeEndpoint(server.url, port, token)
    this.options.log(`导播 API 已启动：${server.url}（令牌见 ${DIRECTOR_API_FILE}）`)
    return this.info
  }

  private writeEndpoint(url: string, port: number, token: string): DirectorApiEndpointFile {
    const info: DirectorApiEndpointFile = {
      url,
      port,
      token,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, `${JSON.stringify(info, null, 2)}\n`, 'utf-8')
    } catch (error) {
      this.options.log(
        `写入 ${DIRECTOR_API_FILE} 失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return info
  }

  async stop() {
    await this.server?.close().catch(() => {})
    this.server = undefined
    this.info = undefined
    try {
      if (existsSync(this.file)) rmSync(this.file)
    } catch {
      // 退出阶段删不掉不影响下次启动
    }
  }
}
