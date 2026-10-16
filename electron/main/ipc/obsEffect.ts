import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { app } from 'electron'
import { IPC_CHANNELS } from '../../../shared/ipcChannels'
import {
  defaultObsCameraConfig,
  type ObsCameraAction,
  type ObsCameraConfig,
  validateObsCameraConfig,
} from '../../../shared/obsCamera'
import {
  defaultObsEnterEffectSettings,
  defaultObsInstantPresentation,
  OBS_INSTANT_INPUTS,
  type ObsInstantPresentation,
  type ObsEffectCommand,
  type ObsEffectResponse,
} from '../../../shared/obsEffect'
import { createLogger } from '../logger'
import { JsonLedger } from '../services/JsonLedger'
import { ObsCameraSwitcher } from '../services/ObsCameraSwitcher'
import { ObsEnterEffectService } from '../services/ObsEnterEffectService'
import { typedIpcMainHandle } from '../utils/ipc'
import { recordAudit } from './audit'

const logger = createLogger('OBS')
let ledger: JsonLedger<typeof defaultObsEnterEffectSettings> | null = null
let service: ObsEnterEffectService | null = null
let cameraLedger: JsonLedger<ObsCameraConfig> | null = null
let camera: ObsCameraSwitcher | null = null
let cameraSignature = ''
let cameraTail: Promise<unknown> = Promise.resolve()
let cameraAction: ObsCameraAction | undefined
let shuttingDown = false
let shutdownPromise: Promise<void> | undefined
let handlersSetup = false
let presentationLedger: JsonLedger<ObsInstantPresentation> | null = null

function getPresentationLedger() {
  if (!presentationLedger) presentationLedger = new JsonLedger(
    path.join(app.getPath('userData'), 'obs-instant-presentation.json'),
    structuredClone(defaultObsInstantPresentation), { backups: 5 },
  )
  return presentationLedger
}

async function applyPresentation(mode: 'wide' | 'focus') {
  getPresentationLedger().change(data => { data.mode = mode })
  return await getObsEffectService().setArtTextPresentation([...OBS_INSTANT_INPUTS], mode)
}

export function getObsCameraLedger() {
  if (!cameraLedger)
    cameraLedger = new JsonLedger(
      path.join(app.getPath('userData'), 'obs-camera.json'),
      structuredClone(defaultObsCameraConfig),
      { backups: 5 },
    )
  return cameraLedger
}

function enqueueCamera<T>(operation: () => Promise<T>): Promise<T> {
  const result = cameraTail.then(operation)
  cameraTail = result.catch(() => {})
  return result
}

async function getCamera() {
  const config = structuredClone(getObsCameraLedger().data)
  validateObsCameraConfig(config)
  const settings = getObsEffectLedger().data
  const connection = { url: settings.url, password: settings.password }
  const signature = JSON.stringify({ config, connection })
  if (!camera || signature !== cameraSignature) {
    await camera?.stop()
    camera = new ObsCameraSwitcher(connection, config, undefined, {
      onAction: action => {
        cameraAction = structuredClone(action)
        recordAudit({
          traceId: randomUUID(),
          origin: 'analysis-ui',
          phase: 'action',
          status: action.ok ? 'done' : 'failed',
          eventType: 'manual.obs.camera-switch',
          scene: config.sceneName,
          ruleName: '手动机位切换',
          actionType: 'obs.camera-switch',
          content: action.target === 'android' ? config.androidSource : config.iphoneSource,
          detail: JSON.stringify(action),
        })
      },
    })
    cameraSignature = signature
  }
  return camera
}

export function getObsEffectLedger() {
  if (!ledger) {
    ledger = new JsonLedger(
      path.join(app.getPath('userData'), 'obs-enter-effect.json'),
      structuredClone(defaultObsEnterEffectSettings),
      { backups: 5 },
    )
  }
  return ledger
}

export function getObsEffectService() {
  if (!service) {
    service = new ObsEnterEffectService(getObsEffectLedger().data, undefined, logger)
    // Seed desired mode synchronously; OBS updates are serialized inside the service.
    void service.setArtTextPresentation([...OBS_INSTANT_INPUTS], getPresentationLedger().data.mode)
      .catch(error => logger.error('恢复互动特效风格失败', error))
  }
  return service
}

/** Diagnostics must not construct a service, restore presentation or connect OBS. */
export function peekObsEffectOperationQueueState() {
  return service?.getOperationQueueState()
}

/** Shared by the desktop IPC and authenticated local API. Camera control has no AI lifecycle. */
export async function executeObsEffectCommand(
  command: ObsEffectCommand,
): Promise<ObsEffectResponse> {
  try {
    if (shuttingDown) throw new Error('应用正在关闭，OBS 控制已停止接收操作')
    if (!command || typeof command.action !== 'string') throw new Error('无效操作')
    switch (command.action) {
      case 'instant-presentation-state':
        return { ok: true, instantPresentation: structuredClone(getPresentationLedger().data) }
      case 'instant-presentation-save':
        return await enqueueCamera(async () => {
          if (!['wide', 'focus'].includes(command.mode) || typeof command.followCamera !== 'boolean')
            throw new Error('特效模式必须为远景或聚焦，跟随机位必须为开关')
          let mode = command.mode
          if (command.followCamera) {
            const status = await (await getCamera()).status(true)
            if (status.selected === 'android') mode = 'wide'
            else if (status.selected === 'iphone') mode = 'focus'
          }
          getPresentationLedger().change(data => { data.followCamera = command.followCamera })
          const applied = await applyPresentation(mode)
          return { ok: true as const, instantPresentation: structuredClone(getPresentationLedger().data),
            message: applied?.skipped?.length ? '风格已保存，部分 OBS 来源尚未就绪；下次触发时应用' : '互动特效风格已保存' }
        })
      case 'camera-state':
      case 'camera-status':
        return await enqueueCamera(async () => ({
          ok: true as const,
          cameraConfig: structuredClone(getObsCameraLedger().data),
          cameraStatus: await (await getCamera()).status(command.action === 'camera-status'),
          cameraAction,
        }))
      case 'camera-save':
        return await enqueueCamera(async () => {
          validateObsCameraConfig(command.config)
          await camera?.stop()
          camera = null
          cameraSignature = ''
          getObsCameraLedger().change(data => {
            // Replace optional fields as well: selecting a legacy cut must not retain an old fade.
            for (const key of Object.keys(data))
              delete (data as unknown as Record<string, unknown>)[key]
            Object.assign(data, command.config)
          })
          return {
            ok: true as const,
            cameraConfig: structuredClone(getObsCameraLedger().data),
            message: 'OBS 机位配置已保存',
          }
        })
      case 'camera-switch':
        return await enqueueCamera(async () => {
          const cameraStatus = await (await getCamera()).switchTo(command.target)
          if (getPresentationLedger().data.followCamera) await applyPresentation(command.target === 'android' ? 'wide' : 'focus')
          return { ok: true as const, cameraStatus, cameraAction,
            instantPresentation: structuredClone(getPresentationLedger().data),
            message: `已切到${command.target === 'android' ? '安卓' : 'iPhone'}机位` }
        })
    }
    const currentService = getObsEffectService()
    switch (command.action) {
      case 'welcome-presets':
        return { ok: true, welcomePresets: await currentService.getWelcomePresets() }
      case 'state':
        return { ok: true, settings: currentService.getSettings(), instantPresentation: structuredClone(getPresentationLedger().data) }
      case 'save':
        await currentService.configure(command.settings)
        getObsEffectLedger().change(data => Object.assign(data, currentService.getSettings()))
        return {
          ok: true,
          settings: currentService.getSettings(),
          message: 'OBS 特效规则已保存',
        }
      case 'test':
        await currentService.test(command.settings)
        return { ok: true, message: 'OBS 连接及场景来源检查成功' }
      case 'discover':
        return {
          ok: true,
          scenes: await currentService.discover(command.url, command.password),
          message: '已读取 OBS 场景和来源',
        }
      case 'trigger':
        await currentService.preview(command.settings)
        return { ok: true, message: '已触发 OBS 来源' }
      default:
        throw new Error('未知操作')
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'OBS 操作失败' }
  }
}

/** Drain admitted camera operations and restore OBS before releasing the app quit barrier. */
export function shutdownObsEffects(): Promise<void> {
  if (shutdownPromise) return shutdownPromise
  shuttingDown = true
  shutdownPromise = (async () => {
    // An admitted camera fade may still update the following overlay; drain it before disconnecting.
    const cameraResult = await Promise.allSettled([enqueueCamera(async () => {
      await camera?.stop()
      camera = null
      cameraSignature = ''
    })])
    const effectResult = await Promise.allSettled([Promise.resolve().then(() => service?.stop()),import('./effectGroups').then(module=>module.shutdownEffectGroups())])
    for (const result of [...cameraResult, ...effectResult])
      if (result.status === 'rejected') logger.error('关闭 OBS 控制失败', result.reason)
  })()
  return shutdownPromise
}

export function setupObsEffectIpcHandlers() {
  if (handlersSetup) return
  handlersSetup = true
  let readyToQuit = false
  let quitting = false
  app.on('before-quit', event => {
    if (readyToQuit) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    void shutdownObsEffects().finally(() => {
      readyToQuit = true
      app.quit()
    })
  })
  typedIpcMainHandle(IPC_CHANNELS.obsEffect.request, (_event, command) =>
    executeObsEffectCommand(command),
  )
}
