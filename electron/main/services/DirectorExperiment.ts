import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { DirectorExperimentResponse } from '../../../shared/directorExperiment'

export const EXPERIMENT_URL = 'http://127.0.0.1:7789/'
const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
const bundledRoot = resources && path.join(resources, 'interaction-runtime/experiments/micro_director_demo_20261009')
export const EXPERIMENT_ROOT = bundledRoot && existsSync(path.join(bundledRoot, 'start.cjs'))
  ? bundledRoot : 'C:/Users/luizs/Desktop/voice/experiments/micro_director_demo_20261009'
const bundledNode = resources && path.join(resources, 'interaction-runtime/node/node.exe')
const node = bundledNode && existsSync(bundledNode)
  ? bundledNode : 'C:/Program Files/DSH Desktop/resources/app/node_modules/node/bin/node.exe'
type Probe = () => Promise<{ ready: boolean; modelReady?: boolean }>
export class DirectorExperiment {
  private starting: Promise<DirectorExperimentResponse> | null = null
  private ownedLaunch: (() => boolean) | null = null
  constructor(private dependencies: {
    probe: Probe
    launch: () => void | (() => boolean)
    available: () => boolean
    wait: () => Promise<void>
  } = {
    async probe() {
      let health: Response
      try { health = await fetch(EXPERIMENT_URL + 'health', { signal: AbortSignal.timeout(1500), redirect: 'error' }) }
      catch (error) {
        if ((error as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED') return { ready: false }
        throw new Error('实验端口暂不可访问，请检查已有服务；没有重复启动')
      }
      let data: { service?: string }
      try { data = await health.json() }
      catch { throw new Error('7789 由其他服务占用，没有启动模型') }
      if (!health.ok || data.service !== 'micro-director-demo') throw new Error('7789 由其他服务占用，没有启动模型')
      const audience = await fetch(EXPERIMENT_URL + 'api/audience/source', { signal: AbortSignal.timeout(1500), redirect: 'error' })
      if (!audience.ok) throw new Error('7789 是旧版实验，请升级该本机服务后再试')
      const status = await fetch(EXPERIMENT_URL + 'api/status', { signal: AbortSignal.timeout(1500), redirect: 'error' })
      return { ready: true, modelReady: status.ok && (await status.json()).ready === true }
    },
    available: () => existsSync(node) && existsSync(path.join(EXPERIMENT_ROOT, 'start.cjs')),
    launch() {
      const child = spawn(node, [path.join(EXPERIMENT_ROOT, 'start.cjs')], {
        cwd: EXPERIMENT_ROOT, windowsHide: true, detached: true, stdio: 'ignore',
      })
      child.on('error', () => {})
      child.unref()
      return () => child.exitCode === null && child.signalCode === null && !!child.pid
    },
    wait: () => new Promise(resolve => setTimeout(resolve, 200)),
  }) {}
  async status(): Promise<DirectorExperimentResponse> {
    try {
      const status = await this.dependencies.probe()
      return { ok: true, ...status, ...(status.ready ? { url: EXPERIMENT_URL } : {}), mode: 'local-experiment' }
    } catch (error) {
      return { ok: false, ready: false, error: error instanceof Error ? error.message : '无法检查实验服务', mode: 'local-experiment' }
    }
  }
  start(): Promise<DirectorExperimentResponse> {
    if (this.starting) return this.starting
    this.starting = this.startOnce().finally(() => { this.starting = null })
    return this.starting
  }
  private async startOnce(): Promise<DirectorExperimentResponse> {
    const current = await this.status()
    if (!current.ok || current.ready) return current
    if (this.ownedLaunch?.()) return { ok: false, ready: false, mode: 'local-experiment', error: '实验服务仍在启动，请稍后重新检查；没有重复装载模型' }
    if (!this.dependencies.available()) return { ok: false, ready: false, mode: 'local-experiment', error: '找不到本机配音实验目录或 Node 运行时；请保留桌面 voice 文件夹' }
    try {
      this.ownedLaunch = this.dependencies.launch() || null
      for (let attempt = 0; attempt < 25; attempt++) {
        await this.dependencies.wait()
        const state = await this.status()
        if (!state.ok || state.ready) return state
      }
      return { ok: false, ready: false, mode: 'local-experiment', error: '等待后实验服务仍未就绪，请检查本机7789服务日志；没有再次启动' }
    } catch {
      return { ok: false, ready: false, mode: 'local-experiment', error: '实验服务未能启动，请检查本机运行时' }
    }
  }
}
