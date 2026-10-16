import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, stat } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  type ObsCameraConfig,
  type ObsCameraTarget,
  validateObsCameraConfig,
} from '../../../shared/obsCamera'
import {
  OBS_CAMERA_RECORDING_FILTERS,
  type ObsCameraRecordingCamera,
  type ObsCameraRecordingCommand,
  type ObsCameraRecordingMark,
  type ObsCameraRecordingState,
} from '../../../shared/obsCameraRecording'
import type { ObsRpcClient } from './ObsWebSocketClient'

const TARGETS: ObsCameraTarget[] = ['iphone', 'android']
const MAX_MARKS = 1000
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
type Connection = { url: string; password: string }
type Run = {
  id: string
  config: ObsCameraConfig
  connection: Connection
  attempted: Set<ObsCameraTarget>
  pending: Set<ObsCameraTarget>
  files: Map<ObsCameraTarget, string>
  stems: Map<ObsCameraTarget, string>
  formats: Map<ObsCameraTarget, string>
  directories: Map<ObsCameraTarget, string>
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'OBS 独立录像操作失败'
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const hasControls = (value: string) =>
  Array.from(value).some(
    character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  )
const validId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  !/\s/.test(value) &&
  !hasControls(value)
const validPath = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value) && !hasControls(value)

/** Owns only targeted Source Record starts issued by this instance. Reopened indexes are read-only. */
export class ObsCameraRecordingControl {
  private tail: Promise<unknown> = Promise.resolve()
  private run?: Run
  private loaded = false
  private lastStartId?: string
  private state: ObsCameraRecordingState = {
    ok: true,
    ready: false,
    running: false,
    cameras: [],
    marks: [],
  }
  constructor(
    private client: ObsRpcClient,
    private settings: () => Connection,
    private config: () => ObsCameraConfig,
    private journalDir?: string,
  ) {
    if (journalDir !== undefined && !validPath(journalDir))
      throw new Error('独立录像索引目录必须是有效的绝对路径')
  }
  peekRunId() {
    return this.run?.id
  }
  peekState(): ObsCameraRecordingState {
    return structuredClone(this.state)
  }
  execute(command: ObsCameraRecordingCommand): Promise<ObsCameraRecordingState> {
    const pending = this.tail
      .catch(() => {})
      .then(async () => {
        this.validate(command)
        await this.loadHistory()
        if (
          (command.action === 'stop' || command.action === 'mark') &&
          (!this.run || command.runId !== this.run.id)
        )
          throw new Error('录像批次已失效；重新打开的索引仅供查看，请在 OBS 中停止外部录像')
        this.state.ok = true
        delete this.state.error
        try {
          if (command.action !== 'status' && this.run && this.state.running) this.requireFrozen()
          const connection = structuredClone(
            command.action === 'start'
              ? this.settings()
              : (this.run?.connection ?? this.settings()),
          )
          await this.client.connect(connection.url, connection.password)
          if (command.action === 'start') await this.start(command.requestId, connection)
          else if (command.action === 'mark') await this.mark(command)
          else if (command.action === 'stop') await this.stop()
          else await this.refresh()
        } catch (error) {
          this.state.ok = false
          this.state.error = message(error)
          if (command.action === 'mark') this.state.lastMarkError = this.state.error
        } finally {
          if (this.run && this.state.indexPath) {
            try {
              await this.persist()
            } catch (error) {
              this.state.ok = false
              this.state.error = `录像索引保存失败：${message(error)}`
            }
          }
          await this.client.disconnect().catch(() => {})
        }
        return this.peekState()
      })
    this.tail = pending.catch(() => {})
    return pending
  }
  private validate(command: ObsCameraRecordingCommand) {
    if (!command || !['status', 'start', 'stop', 'mark'].includes(command.action))
      throw new Error('独立录像命令无效')
    if (command.action !== 'status' && !validId(command.requestId))
      throw new Error('录像请求编号无效')
    if ((command.action === 'stop' || command.action === 'mark') && !validId(command.runId))
      throw new Error('录像批次编号无效')
    if (
      command.action === 'mark' &&
      command.label !== undefined &&
      (typeof command.label !== 'string' ||
        command.label.length > 100 ||
        hasControls(command.label))
    )
      throw new Error('打点标签最多 100 字且不能含控制字符')
  }
  private requireFrozen() {
    if (
      JSON.stringify(this.config()) !== JSON.stringify(this.run!.config) ||
      JSON.stringify(this.settings()) !== JSON.stringify(this.run!.connection)
    )
      throw new Error('录像期间机位或 OBS 连接配置已变化，请恢复配置后操作')
  }
  private cameras(config: ObsCameraConfig): ObsCameraRecordingCamera[] {
    return TARGETS.map(target => ({
      target,
      sourceName: target === 'iphone' ? config.iphoneSource : config.androidSource,
      filterName: OBS_CAMERA_RECORDING_FILTERS[target],
      active: false,
      owned: false,
    }))
  }
  private async inspect(
    config: ObsCameraConfig,
    only?: ObsCameraTarget,
    runtime = false,
  ): Promise<Map<ObsCameraTarget, Record<string, unknown>>> {
    validateObsCameraConfig(config)
    if (config.switchMode !== 'scene') throw new Error('独立录像打点需要两个独立机位场景')
    const scenes = await this.client.call('GetSceneList')
    if (!Array.isArray(scenes.scenes)) throw new Error('无法确认 OBS 机位场景')
    const result = new Map<ObsCameraTarget, Record<string, unknown>>()
    for (const camera of this.cameras(config).filter(camera => !only || camera.target === only)) {
      const sceneName =
        camera.target === 'iphone' ? config.iphoneSceneName : config.androidSceneName
      if (
        scenes.scenes.filter(scene => object(scene) && scene.sceneName === sceneName).length !== 1
      )
        throw new Error(`找不到唯一机位场景「${sceneName}」`)
      const items = await this.client.call('GetSceneItemList', { sceneName })
      if (
        !Array.isArray(items.sceneItems) ||
        items.sceneItems.filter(
          item =>
            object(item) && item.sourceName === camera.sourceName && item.sceneItemEnabled === true,
        ).length !== 1
      )
        throw new Error(`机位场景需要唯一且已启用的直属来源「${camera.sourceName}」`)
      const list = await this.client.call('GetSourceFilterList', { sourceName: camera.sourceName })
      if (
        !Array.isArray(list.filters) ||
        list.filters.filter(filter => object(filter) && filter.filterName === camera.filterName)
          .length !== 1
      )
        throw new Error(`请先安装独立录像滤镜「${camera.filterName}」`)
      for (const listed of list.filters) {
        if (
          object(listed) &&
          listed.filterName !== camera.filterName &&
          listed.filterKind === 'source_record_filter' &&
          listed.filterEnabled !== false
        )
          throw new Error(`来源「${camera.sourceName}」存在其他启用的 Source Record 滤镜`)
      }
      const filter = await this.client.call('GetSourceFilter', {
        sourceName: camera.sourceName,
        filterName: camera.filterName,
      })
      if (
        filter.filterKind !== 'source_record_filter' ||
        filter.filterEnabled !== true ||
        !object(filter.filterSettings)
      )
        throw new Error(`独立录像滤镜「${camera.filterName}」类型不符或未启用`)
      const settings = filter.filterSettings
      const ownedMode =
        runtime &&
        this.run?.attempted.has(camera.target) &&
        settings.record_mode === 1 &&
        settings.filename_formatting === this.run.formats.get(camera.target)
      if (
        (settings.record_mode !== 0 && !ownedMode) ||
        !['hybrid_mov', 'hybrid_mp4'].includes(String(settings.rec_format)) ||
        (settings.split_file !== undefined && settings.split_file !== false) ||
        (settings.stream_mode !== undefined && settings.stream_mode !== 0) ||
        (settings.replay_buffer !== undefined && settings.replay_buffer !== false) ||
        !validPath(settings.path)
      )
        throw new Error(
          `独立录像滤镜「${camera.filterName}」需要手动模式、Hybrid MOV/MP4、绝对保存目录并关闭分段、推流与回放缓存`,
        )
      result.set(camera.target, structuredClone(settings))
    }
    return result
  }
  private async outputList() {
    const result = await this.client.call('GetOutputList')
    if (
      !Array.isArray(result.outputs) ||
      result.outputs.some(
        item =>
          !object(item) ||
          typeof item.outputName !== 'string' ||
          typeof item.outputActive !== 'boolean',
      )
    )
      throw new Error('OBS 未返回可确认的输出列表')
    return result.outputs as Array<{
      outputName: string
      outputActive: boolean
      outputKind?: string
    }>
  }
  private async readOutput(
    camera: ObsCameraRecordingCamera,
    outputs: Array<{ outputName: string; outputActive: boolean; outputKind?: string }>,
  ) {
    const matches = outputs.filter(output => output.outputName === camera.filterName)
    camera.active = false
    camera.owned = false
    delete camera.error
    if (!matches.length) return
    if (matches.length !== 1) throw new Error(`独立录像输出「${camera.filterName}」不唯一`)
    const status = await this.client.call('GetOutputStatus', { outputName: camera.filterName })
    if (typeof status.outputActive !== 'boolean') throw new Error('OBS 未确认独立录像输出状态')
    camera.active = status.outputActive
    if (!camera.active) return
    if (!['mov_output', 'mp4_output'].includes(String(matches[0].outputKind)))
      throw new Error('当前独立录像输出格式不支持章节')
    const settings = await this.client.call('GetOutputSettings', { outputName: camera.filterName })
    const file = object(settings.outputSettings) ? settings.outputSettings.path : undefined
    if (!validPath(file) || !/\.(mov|mp4)$/i.test(file))
      throw new Error('OBS 未返回有效的录像文件绝对路径')
    if (object(settings.outputSettings) && settings.outputSettings.split_file === true)
      throw new Error('分段录像无法可靠定位章节，请先在 OBS 停止分段录像')
    if (
      typeof status.outputDuration !== 'number' ||
      !Number.isSafeInteger(status.outputDuration) ||
      status.outputDuration < 0
    )
      throw new Error('OBS 未返回有效的录像毫秒时长')
    if (status.outputPaused === true) throw new Error('当前机位录像已暂停')
    if (
      camera.outputPath === file &&
      camera.outputDurationMs !== undefined &&
      status.outputDuration < camera.outputDurationMs
    )
      throw new Error('录像时长已重新计数，无法确认同一文件的章节位置，请在 OBS 核实')
    camera.outputPath = file
    camera.outputDurationMs = status.outputDuration
    if (this.run?.attempted.has(camera.target)) {
      const stem = this.run.stems.get(camera.target)!
      const previousFile = this.run.files.get(camera.target)
      if (
        path.dirname(file) !== this.run.directories.get(camera.target) ||
        !path.basename(file).startsWith(stem) ||
        (previousFile && previousFile !== file)
      )
        throw new Error('录像文件已变化，无法确认输出归属或章节时间；请在 OBS 核实')
      this.run.files.set(camera.target, file)
      camera.owned = true
      this.run.pending.delete(camera.target)
    }
  }
  private async refresh() {
    const config = this.run?.config ?? this.config()
    const previous = this.state.cameras
    this.state.cameras = this.cameras(config)
    this.state.ready = false
    const errors: string[] = []
    let filterSettings: Map<ObsCameraTarget, Record<string, unknown>> | undefined
    try {
      filterSettings = await this.inspect(config, undefined, true)
      this.state.ready = true
    } catch (error) {
      errors.push(message(error))
    }
    const outputs = await this.outputList()
    for (const camera of this.state.cameras) {
      try {
        await this.readOutput(camera, outputs)
      } catch (error) {
        camera.error = message(error)
        errors.push(camera.error)
      }
      if (!camera.active && this.run?.attempted.has(camera.target)) {
        const settings = filterSettings?.get(camera.target)
        if (
          settings?.record_mode === 1 &&
          settings.filename_formatting === this.run.formats.get(camera.target)
        )
          this.run.pending.add(camera.target)
        else if (settings?.record_mode === 0) {
          this.run.pending.delete(camera.target)
          this.run.attempted.delete(camera.target)
        }
      }
      const old = previous.find(value => value.target === camera.target)
      camera.outputPath ??= old?.outputPath
      camera.outputDurationMs ??= old?.outputDurationMs
    }
    this.updateRunning()
    if (errors.length) throw new Error(errors.join('；'))
  }
  private async start(requestId: string, connection: Connection) {
    if (this.lastStartId === requestId) return
    if (this.run && this.state.running) throw new Error('当前独立录像尚未停止')
    const config = structuredClone(this.config())
    const settings = await this.inspect(config)
    if (
      (await this.outputList()).some(
        output =>
          output.outputActive &&
          Object.values(OBS_CAMERA_RECORDING_FILTERS).includes(
            output.outputName as typeof OBS_CAMERA_RECORDING_FILTERS.iphone,
          ),
      )
    )
      throw new Error('独立录像输出已被其他操作启动，请在 OBS 核实并停止外部录像后再开始')
    if (
      JSON.stringify(this.config()) !== JSON.stringify(config) ||
      JSON.stringify(this.settings()) !== JSON.stringify(connection)
    )
      throw new Error('启动验证期间机位或 OBS 连接配置已变化，请重新开始')
    const id = randomUUID()
    const directory = this.journalDir ?? String(settings.get('iphone')!.path)
    await mkdir(directory, { recursive: true })
    const manifestPath = path.join(directory, `oba-camera-recording-${id}.json`)
    const indexPath = path.join(directory, `oba-camera-recording-${id}.csv`)
    this.run = {
      id,
      config,
      connection,
      attempted: new Set(),
      pending: new Set(),
      files: new Map(),
      stems: new Map(),
      formats: new Map(),
      directories: new Map(),
    }
    this.lastStartId = requestId
    this.state = {
      ok: true,
      ready: true,
      running: false,
      runId: id,
      startedAt: Date.now(),
      cameras: this.cameras(config),
      marks: [],
      indexPath,
      manifestPath,
    }
    await this.persist()
    const errors: string[] = []
    for (const camera of this.state.cameras) {
      const stem = `OBA_${id}_${camera.target}_`
      const format = `${stem}%CCYY-%MM-%DD_%hh-%mm-%ss`
      this.run.stems.set(camera.target, stem)
      this.run.formats.set(camera.target, format)
      this.run.directories.set(
        camera.target,
        path.normalize(String(settings.get(camera.target)!.path)),
      )
      try {
        this.requireFrozen()
        await this.client.call('SetSourceFilterSettings', {
          sourceName: camera.sourceName,
          filterName: camera.filterName,
          filterSettings: { filename_formatting: format },
          overlay: true,
        })
        const verified = await this.client.call('GetSourceFilter', {
          sourceName: camera.sourceName,
          filterName: camera.filterName,
        })
        if (
          !object(verified.filterSettings) ||
          verified.filterSettings.filename_formatting !== format
        )
          throw new Error('OBS 未确认本批次独立文件名')
        this.run.attempted.add(camera.target)
        this.run.pending.add(camera.target)
        await this.persist()
        this.requireFrozen()
        await this.vendor(camera, 'record_start')
        await this.confirmOutput(camera, true)
      } catch (error) {
        errors.push(`${camera.sourceName}：${message(error)}`)
      }
      try {
        await this.readOutput(camera, await this.outputList())
      } catch (error) {
        errors.push(message(error))
        camera.error = message(error)
      }
      if (!camera.active || !camera.owned)
        errors.push(`OBS 未确认「${camera.sourceName}」独立录像启动，请在 OBS 核实`)
      if (!camera.owned && this.run.pending.has(camera.target)) {
        const filter = await this.client.call('GetSourceFilter', {
          sourceName: camera.sourceName,
          filterName: camera.filterName,
        })
        if (object(filter.filterSettings) && filter.filterSettings.record_mode === 0) {
          this.run.pending.delete(camera.target)
          this.run.attempted.delete(camera.target)
        }
      }
      this.updateRunning()
      await this.persist()
    }
    if (errors.length) throw new Error(errors.join('；'))
  }
  private async vendor(
    camera: ObsCameraRecordingCamera,
    requestType: string,
    chapterName?: string,
  ) {
    const result = await this.client.call('CallVendorRequest', {
      vendorName: 'source-record',
      requestType,
      requestData: {
        source: camera.sourceName,
        filter: camera.filterName,
        ...(chapterName === undefined ? {} : { chapter_name: chapterName }),
      },
    })
    if (!object(result.responseData) || result.responseData.success !== true)
      throw new Error(
        object(result.responseData) && typeof result.responseData.error === 'string'
          ? result.responseData.error
          : 'Source Record 未确认接收命令',
      )
  }
  private async mark(command: Extract<ObsCameraRecordingCommand, { action: 'mark' }>) {
    const existing = this.state.marks.find(mark => mark.requestId === command.requestId)
    if (existing) {
      if (existing.status !== 'confirmed')
        throw new Error(existing.error ?? '该打点请求已发送但未确认，请检查 OBS；不会重复发送')
      return
    }
    if (this.state.marks.length >= MAX_MARKS)
      throw new Error('本批次已达到 1000 个打点，请开始新的录像批次')
    const program = await this.client.call('GetCurrentProgramScene')
    const scene = program.currentProgramSceneName
    const target =
      scene === this.run!.config.iphoneSceneName
        ? 'iphone'
        : scene === this.run!.config.androidSceneName
          ? 'android'
          : undefined
    if (!target) throw new Error('当前实际节目不是已配置的机位场景，未写入章节')
    const camera = this.state.cameras.find(value => value.target === target)!
    const filters = await this.inspect(this.run!.config, target, true)
    if (filters.get(target)!.filename_formatting !== this.run!.formats.get(target))
      throw new Error('独立录像滤镜已被其他操作修改')
    await this.readOutput(camera, await this.outputList())
    if (
      !camera.active ||
      !camera.owned ||
      !camera.outputPath ||
      camera.outputDurationMs === undefined
    )
      throw new Error('当前节目机位没有本批次的活动独立录像，未写入章节')
    const sequence = this.state.marks.length + 1
    const label = command.label ?? ''
    const mark: ObsCameraRecordingMark = {
      runId: command.runId,
      requestId: command.requestId,
      sequence,
      target,
      sourceName: camera.sourceName,
      filterName: camera.filterName,
      programScene: String(scene),
      label,
      chapterName: `OBA ${String(sequence).padStart(4, '0')}${label ? ` · ${label}` : ''}`,
      outputPath: camera.outputPath,
      offsetMs: camera.outputDurationMs,
      requestedAt: Date.now(),
      status: 'pending',
    }
    this.state.marks.push(mark)
    await this.persist()
    let sent = false
    try {
      await this.readOutput(camera, await this.outputList())
      if (
        !camera.active ||
        !camera.owned ||
        camera.outputPath !== mark.outputPath ||
        camera.outputDurationMs! < mark.offsetMs
      )
        throw new Error('打点前录像文件或计时已变化，未写入章节')
      const finalProgram = await this.client.call('GetCurrentProgramScene')
      if (finalProgram.currentProgramSceneName !== scene)
        throw new Error('打点前实际节目已切换，未写入章节，请重新打点')
      this.requireFrozen()
      sent = true
      await this.vendor(camera, 'record_add_chapter', mark.chapterName)
      await this.readOutput(camera, await this.outputList())
      if (
        !camera.active ||
        !camera.owned ||
        camera.outputPath !== mark.outputPath ||
        camera.outputDurationMs! < mark.offsetMs
      )
        throw new Error('章节请求后录像文件或计时已变化，写入位置未确认，请检查文件内章节')
      mark.status = 'confirmed'
      delete this.state.lastMarkError
    } catch (error) {
      mark.status = sent ? 'unconfirmed' : 'failed'
      mark.error = message(error)
      throw error
    } finally {
      await this.persist()
    }
  }
  private async stop() {
    const errors: string[] = []
    for (const camera of this.state.cameras) {
      try {
        await this.readOutput(camera, await this.outputList())
        if (!camera.active && !this.run!.attempted.has(camera.target)) continue
        if (camera.active && !camera.owned)
          throw new Error(`「${camera.sourceName}」录像归属无法确认，请在 OBS 中停止`)
        const filter = await this.client.call('GetSourceFilter', {
          sourceName: camera.sourceName,
          filterName: camera.filterName,
        })
        if (
          filter.filterKind !== 'source_record_filter' ||
          !object(filter.filterSettings) ||
          filter.filterSettings.filename_formatting !== this.run!.formats.get(camera.target)
        )
          throw new Error('独立录像滤镜已被其他操作修改，请在 OBS 中停止')
        if (!camera.active && filter.filterSettings.record_mode === 0) {
          this.run!.attempted.delete(camera.target)
          this.run!.pending.delete(camera.target)
          continue
        }
        this.run!.pending.add(camera.target)
        await this.vendor(camera, 'record_stop')
        await this.confirmOutput(camera, false)
        this.run!.attempted.delete(camera.target)
        this.run!.pending.delete(camera.target)
      } catch (error) {
        camera.error = message(error)
        errors.push(camera.error)
      }
    }
    this.updateRunning()
    if (errors.length) throw new Error(errors.join('；'))
  }
  private async persist() {
    if (!this.state.manifestPath || !this.state.indexPath) return
    const serialized = JSON.stringify({ schemaVersion: 1, ...this.state }, null, 2)
    if (Buffer.byteLength(serialized) > MAX_MANIFEST_BYTES)
      throw new Error('录像索引超过安全大小限制')
    await this.writeAtomic(this.state.manifestPath, serialized)
    const csvCell = (value: unknown) => {
      let text = String(value ?? '')
      if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`
      return `"${text.replace(/"/g, '""')}"`
    }
    const rows: unknown[][] = [
      [
        'sequence',
        'camera',
        'file',
        'approx_offset_ms',
        'label',
        'chapter_name',
        'status',
        'requested_at',
        'error',
      ],
    ]
    for (const mark of this.state.marks)
      rows.push([
        mark.sequence,
        mark.target,
        mark.outputPath,
        mark.offsetMs,
        mark.label,
        mark.chapterName,
        mark.status,
        mark.requestedAt,
        mark.error,
      ])
    await this.writeAtomic(
      this.state.indexPath,
      `\uFEFF${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`,
    )
  }
  private async writeAtomic(destination: string, content: string) {
    const temporary = `${destination}.tmp`
    const file = await open(temporary, 'w', 0o600)
    try {
      await file.writeFile(content)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, destination)
  }
  private updateRunning() {
    this.state.running =
      this.state.cameras.some(camera => camera.active && camera.owned) || !!this.run?.pending.size
  }
  private async confirmOutput(camera: ObsCameraRecordingCamera, active: boolean) {
    const deadline = performance.now() + 3000
    while (true) {
      await this.readOutput(camera, await this.outputList())
      if (active && camera.active && camera.owned) return
      if (!active && !camera.active) {
        const filter = await this.client.call('GetSourceFilter', {
          sourceName: camera.sourceName,
          filterName: camera.filterName,
        })
        if (object(filter.filterSettings) && filter.filterSettings.record_mode === 0) return
      }
      if (performance.now() >= deadline)
        throw new Error(
          active
            ? 'OBS 未确认独立录像启动，请核实离线机位'
            : 'OBS 未确认独立录像停止，请在 OBS 核实',
        )
      await delay(100)
    }
  }
  private async loadHistory() {
    if (this.loaded) return
    this.loaded = true
    if (!this.journalDir) return
    let names: string[]
    try {
      names = (await readdir(this.journalDir))
        .filter(name => /^oba-camera-recording-[0-9a-f-]{36}\.json$/.test(name))
        .slice(-64)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const candidates = await Promise.all(
      names.map(async name => ({
        file: path.join(this.journalDir!, name),
        info: await stat(path.join(this.journalDir!, name)),
      })),
    )
    for (const candidate of candidates.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)) {
      if (!candidate.info.isFile() || candidate.info.size > MAX_MANIFEST_BYTES) continue
      try {
        const saved: unknown = JSON.parse(await readFile(candidate.file, 'utf8'))
        if (
          !object(saved) ||
          saved.schemaVersion !== 1 ||
          !validId(saved.runId) ||
          !Array.isArray(saved.marks) ||
          saved.marks.length > MAX_MARKS
        )
          continue
        const marks = saved.marks
          .filter(
            (mark): mark is ObsCameraRecordingMark =>
              object(mark) &&
              mark.runId === saved.runId &&
              validId(mark.requestId) &&
              ['iphone', 'android'].includes(String(mark.target)) &&
              typeof mark.sequence === 'number' &&
              typeof mark.label === 'string' &&
              mark.label.length <= 100 &&
              typeof mark.chapterName === 'string' &&
              validPath(mark.outputPath) &&
              typeof mark.offsetMs === 'number' &&
              Number.isSafeInteger(mark.offsetMs) &&
              mark.offsetMs >= 0 &&
              typeof mark.requestedAt === 'number' &&
              ['pending', 'confirmed', 'unconfirmed', 'failed'].includes(String(mark.status)),
          )
          .map(mark => ({
            runId: mark.runId,
            requestId: mark.requestId,
            sequence: mark.sequence,
            target: mark.target,
            sourceName: String(mark.sourceName),
            filterName: String(mark.filterName),
            programScene: String(mark.programScene),
            label: mark.label,
            chapterName: mark.chapterName,
            outputPath: mark.outputPath,
            offsetMs: mark.offsetMs,
            requestedAt: mark.requestedAt,
            status: mark.status === 'pending' ? ('unconfirmed' as const) : mark.status,
            ...(typeof mark.error === 'string' ? { error: mark.error } : {}),
          }))
        const cameras = Array.isArray(saved.cameras)
          ? saved.cameras
              .filter(
                camera => object(camera) && TARGETS.includes(camera.target as ObsCameraTarget),
              )
              .slice(0, 2)
              .map(camera => ({
                target: camera.target as ObsCameraTarget,
                sourceName: String(camera.sourceName),
                filterName: String(camera.filterName),
                active: false,
                owned: false,
                ...(validPath(camera.outputPath) ? { outputPath: camera.outputPath } : {}),
                ...(typeof camera.outputDurationMs === 'number' &&
                Number.isSafeInteger(camera.outputDurationMs)
                  ? { outputDurationMs: camera.outputDurationMs }
                  : {}),
              }))
          : []
        this.state = {
          ok: true,
          ready: false,
          running: false,
          runId: saved.runId,
          startedAt: typeof saved.startedAt === 'number' ? saved.startedAt : undefined,
          cameras,
          marks,
          indexPath: candidate.file.replace(/\.json$/, '.csv'),
          manifestPath: candidate.file,
        }
        return
      } catch {
        /* A corrupt or interrupted older index cannot grant ownership. */
      }
    }
  }
}
