import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ObsCameraRecordingControl } from '../electron/main/services/ObsCameraRecordingControl'
import type { ObsRpcClient } from '../electron/main/services/ObsWebSocketClient'
import { defaultObsCameraConfig } from '../shared/obsCamera'

const config = {
  ...defaultObsCameraConfig,
  switchMode: 'scene' as const,
  iphoneSceneName: 'iPhone机位',
  androidSceneName: '小米4K机位',
}
const filters = ['OBA 独立录像 · iPhone', 'OBA 独立录像 · 小米4K']
const sources = [config.iphoneSource, config.androidSource]

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oba-camera-recording-'))
  const outputs = new Map<string, { active: boolean; duration: number; path: string }>()
  const settings = new Map(
    filters.map(name => [
      name,
      {
        record_mode: 0,
        rec_format: 'hybrid_mov',
        path: directory,
        filename_formatting: 'original',
        split_file: false,
      } as Record<string, unknown>,
    ]),
  )
  const calls: { type: string; data?: Record<string, unknown> }[] = []
  let program = config.iphoneSceneName
  let onCall: ((type: string, data?: Record<string, unknown>) => void | Promise<void>) | undefined
  let vendorFailure = ''
  const client: ObsRpcClient = {
    async connect() {},
    async disconnect() {},
    async call(type, data) {
      calls.push({ type, data: structuredClone(data) })
      await onCall?.(type, data)
      if (type === 'GetSceneList')
        return {
          scenes: [config.iphoneSceneName, config.androidSceneName].map(sceneName => ({
            sceneName,
          })),
        }
      if (type === 'GetSceneItemList')
        return {
          sceneItems: [
            {
              sourceName:
                data?.sceneName === config.iphoneSceneName
                  ? config.iphoneSource
                  : config.androidSource,
              sceneItemEnabled: true,
              sceneItemId: 1,
            },
          ],
        }
      if (type === 'GetCurrentProgramScene') return { currentProgramSceneName: program }
      if (type === 'GetSourceFilterList')
        return {
          filters: [
            {
              filterName: filters[sources.indexOf(String(data?.sourceName))],
              filterKind: 'source_record_filter',
              filterEnabled: true,
            },
          ],
        }
      if (type === 'GetSourceFilter')
        return {
          filterKind: 'source_record_filter',
          filterEnabled: true,
          filterSettings: structuredClone(settings.get(String(data?.filterName))),
        }
      if (type === 'SetSourceFilterSettings') {
        Object.assign(settings.get(String(data?.filterName))!, data?.filterSettings)
        return {}
      }
      if (type === 'GetOutputList')
        return {
          outputs: [...outputs].map(([outputName, value]) => ({
            outputName,
            outputActive: value.active,
            outputKind: 'mov_output',
          })),
        }
      if (type === 'GetOutputStatus') {
        const output = outputs.get(String(data?.outputName))
        if (!output) throw new Error('Output not found')
        return { outputActive: output.active, outputDuration: output.duration, outputPaused: false }
      }
      if (type === 'GetOutputSettings')
        return { outputSettings: { path: outputs.get(String(data?.outputName))?.path } }
      if (type === 'CallVendorRequest') {
        const request = data!.requestData as Record<string, unknown>
        assert.equal(
          request.source,
          sources[filters.indexOf(String(request.filter))],
          'vendor calls must target an exact camera and filter',
        )
        const requestType = String(data!.requestType)
        if (requestType === vendorFailure) throw new Error('OBS 请求超时')
        if (requestType === 'record_start') {
          settings.get(String(request.filter))!.record_mode = 1
          outputs.set(String(request.filter), {
            active: true,
            duration: 0,
            path: path.join(
              directory,
              `${String(settings.get(String(request.filter))!.filename_formatting)}.mov`,
            ),
          })
        }
        if (requestType === 'record_stop') {
          settings.get(String(request.filter))!.record_mode = 0
          const output = outputs.get(String(request.filter))
          if (output) output.active = false
        }
        return { responseData: { success: true } }
      }
      throw new Error(`unexpected OBS request ${type}`)
    },
  }
  let currentConfig = structuredClone(config)
  let connection = { url: 'ws://127.0.0.1:4455', password: 'private-password' }
  const service = new ObsCameraRecordingControl(
    client,
    () => connection,
    () => currentConfig,
    directory,
  )
  return {
    service,
    client,
    directory,
    outputs,
    settings,
    calls,
    set program(value: string) {
      program = value
    },
    set vendorFailure(value: string) {
      vendorFailure = value
    },
    set onCall(value: typeof onCall) {
      onCall = value
    },
    set config(value: typeof currentConfig) {
      currentConfig = value
    },
    set connection(value: typeof connection) {
      connection = value
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
    vendor: (type: string) =>
      calls.filter(call => call.type === 'CallVendorRequest' && call.data?.requestType === type),
  }
}

test('starts two independent outputs and records only the actual current program chapter and index', async () => {
  const f = await fixture()
  try {
    const started = await f.service.execute({ action: 'start', requestId: 'start-1' })
    assert.equal(started.running, true)
    assert.equal(started.cameras.filter(camera => camera.active && camera.owned).length, 2)
    assert.equal(f.vendor('record_start').length, 2)
    f.outputs.get(filters[0])!.duration = 12_345
    const marked = await f.service.execute({
      action: 'mark',
      runId: started.runId!,
      requestId: 'mark-1',
      label: '补货',
    })
    assert.equal(marked.marks.length, 1)
    assert.equal(marked.marks[0].target, 'iphone')
    assert.equal(marked.marks[0].offsetMs, 12_345)
    assert.equal(marked.marks[0].label, '补货')
    assert.equal(marked.marks[0].status, 'confirmed')
    assert.equal(marked.marks[0].outputPath, f.outputs.get(filters[0])!.path)
    assert.equal(f.vendor('record_add_chapter').length, 1)
    assert.equal(f.vendor('record_stop').length, 0)
    assert.match(
      String(
        (f.vendor('record_add_chapter')[0].data!.requestData as Record<string, unknown>)
          .chapter_name,
      ),
      /0001.*补货/,
    )
    const manifest = JSON.parse(await readFile(marked.manifestPath!, 'utf8'))
    assert.equal(manifest.marks[0].offsetMs, 12_345)
    assert.equal(JSON.stringify(manifest).includes('private-password'), false)
  } finally {
    await f.cleanup()
  }
})

test('program switch redirects the next chapter without stopping either camera', async () => {
  const f = await fixture()
  try {
    const start = await f.service.execute({ action: 'start', requestId: 'start' })
    f.program = config.androidSceneName
    f.outputs.get(filters[1])!.duration = 4567
    const state = await f.service.execute({
      action: 'mark',
      runId: start.runId!,
      requestId: 'android',
    })
    assert.equal(state.marks[0].target, 'android')
    assert.equal(state.marks[0].offsetMs, 4567)
    assert.equal(f.vendor('record_stop').length, 0)
    assert.equal(f.outputs.get(filters[0])!.active, true)
  } finally {
    await f.cleanup()
  }
})

test('chapter intent is durable before delivery and a timed out request is never repeated', async () => {
  const f = await fixture()
  try {
    const start = await f.service.execute({ action: 'start', requestId: 'start' })
    f.vendorFailure = 'record_add_chapter'
    f.onCall = async (type, data) => {
      if (type === 'CallVendorRequest' && data?.requestType === 'record_add_chapter') {
        const journal = JSON.parse(await readFile(start.manifestPath!, 'utf8'))
        assert.equal(journal.marks[0].status, 'pending')
        assert.equal(journal.marks[0].requestId, 'uncertain')
      }
    }
    const command = {
      action: 'mark' as const,
      runId: start.runId!,
      requestId: 'uncertain',
      label: '上架',
    }
    const state = await f.service.execute(command)
    assert.equal(state.ok, false)
    assert.equal(state.marks[0].status, 'unconfirmed')
    await f.service.execute(command)
    assert.equal(f.vendor('record_add_chapter').length, 1)
    const restart = new ObsCameraRecordingControl(
      f.client,
      () => ({ url: 'ws://127.0.0.1:4455', password: '' }),
      () => config,
      f.directory,
    )
    const history = await restart.execute({ action: 'status' })
    assert.equal(history.marks[0].status, 'unconfirmed')
    assert.equal(
      history.cameras.some(camera => camera.owned),
      false,
    )
    await assert.rejects(restart.execute(command))
    assert.equal(f.vendor('record_add_chapter').length, 1)
  } finally {
    await f.cleanup()
  }
})

test('rechecks program immediately before delivery and refuses a cross-camera race', async () => {
  const f = await fixture()
  try {
    const start = await f.service.execute({ action: 'start', requestId: 'start' })
    let reads = 0
    f.onCall = type => {
      if (type === 'GetCurrentProgramScene' && ++reads === 2) f.program = config.androidSceneName
    }
    const state = await f.service.execute({
      action: 'mark',
      runId: start.runId!,
      requestId: 'raced',
    })
    assert.equal(state.ok, false)
    assert.equal(f.vendor('record_add_chapter').length, 0)
    assert.equal(state.marks[0].status, 'failed')
  } finally {
    await f.cleanup()
  }
})

test('offline alternate camera does not block the active program but inactive program gets no chapter', async () => {
  const f = await fixture()
  try {
    const start = await f.service.execute({ action: 'start', requestId: 'start' })
    f.outputs.get(filters[1])!.active = false
    const iphone = await f.service.execute({
      action: 'mark',
      runId: start.runId!,
      requestId: 'iphone',
    })
    assert.equal(iphone.marks[0].status, 'confirmed')
    f.program = config.androidSceneName
    const android = await f.service.execute({
      action: 'mark',
      runId: start.runId!,
      requestId: 'offline',
    })
    assert.equal(android.ok, false)
    assert.equal(f.vendor('record_add_chapter').length, 1)
    f.program = '其他场景'
    const unknown = await f.service.execute({
      action: 'mark',
      runId: start.runId!,
      requestId: 'unknown',
    })
    assert.equal(unknown.ok, false)
    assert.equal(f.vendor('record_add_chapter').length, 1)
  } finally {
    await f.cleanup()
  }
})

test('start refuses occupied output and unsafe filter settings without changing OBS', async () => {
  for (const unsafe of [
    { record_mode: 1 },
    { rec_format: 'mkv' },
    { split_file: true },
    { stream_mode: 1 },
    { replay_buffer: true },
  ]) {
    const f = await fixture()
    try {
      Object.assign(f.settings.get(filters[0])!, unsafe)
      const state = await f.service.execute({ action: 'start', requestId: 'unsafe' })
      assert.equal(state.ok, false)
      assert.equal(
        f.calls.some(call => call.type.startsWith('Set') || call.type === 'CallVendorRequest'),
        false,
      )
    } finally {
      await f.cleanup()
    }
  }
  const f = await fixture()
  try {
    f.outputs.set(filters[0], {
      active: true,
      duration: 1,
      path: path.join(f.directory, 'external.mov'),
    })
    const state = await f.service.execute({ action: 'start', requestId: 'occupied' })
    assert.equal(state.ok, false)
    assert.equal(f.vendor('record_start').length, 0)
    assert.equal(
      f.calls.some(call => call.type.startsWith('Set')),
      false,
    )
  } finally {
    await f.cleanup()
  }
})

test('partial start keeps a precise owned camera and stop never targets unrelated output', async () => {
  const f = await fixture()
  try {
    f.onCall = (type, data) => {
      if (
        type === 'CallVendorRequest' &&
        data?.requestType === 'record_start' &&
        (data.requestData as Record<string, unknown>).source === config.androidSource
      )
        throw new Error('second camera unavailable')
    }
    const state = await f.service.execute({ action: 'start', requestId: 'partial' })
    assert.equal(state.ok, false)
    assert.equal(state.running, true)
    assert.equal(state.cameras.find(camera => camera.target === 'iphone')?.owned, true)
    assert.equal(state.cameras.find(camera => camera.target === 'android')?.owned, false)
    f.outputs.set('External', {
      active: true,
      duration: 10,
      path: path.join(f.directory, 'external.mov'),
    })
    const stopped = await f.service.execute({
      action: 'stop',
      runId: state.runId!,
      requestId: 'stop',
    })
    assert.equal(stopped.running, false)
    assert.equal(f.outputs.get('External')!.active, true)
    assert.equal(f.vendor('record_stop').length, 1)
  } finally {
    await f.cleanup()
  }
})

test('stale run, changed configuration and changed connection cannot mutate current recording', async () => {
  const f = await fixture()
  try {
    const start = await f.service.execute({ action: 'start', requestId: 'start' })
    await assert.rejects(f.service.execute({ action: 'stop', runId: 'old', requestId: 'stale' }))
    await assert.rejects(
      f.service.execute({ action: 'mark', runId: 'old', requestId: 'stale-mark' }),
    )
    f.config = { ...config, iphoneSource: 'Replacement source' }
    const changed = await f.service.execute({
      action: 'mark',
      runId: start.runId!,
      requestId: 'changed',
    })
    assert.equal(changed.ok, false)
    f.config = config
    f.connection = { url: 'ws://127.0.0.1:9999', password: 'different' }
    const connection = await f.service.execute({
      action: 'stop',
      runId: start.runId!,
      requestId: 'changed-stop',
    })
    assert.equal(connection.ok, false)
    assert.equal(f.vendor('record_add_chapter').length, 0)
    assert.equal(f.vendor('record_stop').length, 0)
  } finally {
    await f.cleanup()
  }
})

test('changed file, invalid time and relative file path never yield a misleading chapter index', async () => {
  for (const mutation of ['file', 'duration', 'relative'] as const) {
    const f = await fixture()
    try {
      const start = await f.service.execute({ action: 'start', requestId: 'start' })
      const output = f.outputs.get(filters[0])!
      if (mutation === 'file') output.path = path.join(f.directory, 'unrelated.mov')
      if (mutation === 'duration') output.duration = Number.NaN
      if (mutation === 'relative') output.path = 'relative.mov'
      const state = await f.service.execute({
        action: 'mark',
        runId: start.runId!,
        requestId: 'invalid',
      })
      assert.equal(state.ok, false)
      assert.equal(f.vendor('record_add_chapter').length, 0)
      if (mutation !== 'duration') {
        await f.service.execute({ action: 'stop', runId: start.runId!, requestId: 'stop-invalid' })
        assert.equal(
          f
            .vendor('record_stop')
            .filter(
              call =>
                (call.data!.requestData as Record<string, unknown>).source === config.iphoneSource,
            ).length,
          0,
        )
      }
    } finally {
      await f.cleanup()
    }
  }
})

test('read-only status does not create filters and bounds command labels and identifiers', async () => {
  const f = await fixture()
  try {
    const status = await f.service.execute({ action: 'status' })
    assert.equal(status.ready, true)
    assert.equal(
      f.calls.some(call => call.type.startsWith('Set') || call.type === 'CallVendorRequest'),
      false,
    )
    await assert.rejects(f.service.execute({ action: 'start', requestId: 'bad id' }))
    const start = await f.service.execute({ action: 'start', requestId: 'valid' })
    for (const label of ['a'.repeat(101), '\ninvalid'])
      await assert.rejects(
        f.service.execute({ action: 'mark', runId: start.runId!, requestId: 'bad-label', label }),
      )
    assert.equal(f.vendor('record_add_chapter').length, 0)
  } finally {
    await f.cleanup()
  }
})

test('waits for OBS queued start and stop transitions instead of claiming acknowledgement is final', async () => {
  const f = await fixture()
  try {
    let hidden = 0
    const base = f.client.call.bind(f.client)
    f.client.call = async (type, data) => {
      const result = await base(type, data)
      if (type === 'CallVendorRequest' && data?.requestType === 'record_start') hidden = 2
      if (type === 'GetOutputList' && hidden-- > 0) return { outputs: [] }
      if (type === 'CallVendorRequest' && data?.requestType === 'record_stop') {
        const name = String((data.requestData as Record<string, unknown>).filter)
        f.outputs.get(name)!.active = true
        setTimeout(() => {
          f.outputs.get(name)!.active = false
        }, 20)
      }
      return result
    }
    const started = await f.service.execute({ action: 'start', requestId: 'queued' })
    assert.equal(started.ok, true)
    assert.equal(started.cameras.filter(camera => camera.owned).length, 2)
    const stopped = await f.service.execute({
      action: 'stop',
      runId: started.runId!,
      requestId: 'queued-stop',
    })
    assert.equal(stopped.ok, true)
    assert.equal(stopped.running, false)
  } finally {
    await f.cleanup()
  }
})

test('confirmed stop relinquishes ownership and reopened index retains both finished file locations', async () => {
  const f = await fixture()
  try {
    const start = await f.service.execute({ action: 'start', requestId: 'start' })
    await f.service.execute({ action: 'stop', runId: start.runId!, requestId: 'stop' })
    const restart = new ObsCameraRecordingControl(
      f.client,
      () => ({ url: 'ws://127.0.0.1:4455', password: '' }),
      () => config,
      f.directory,
    )
    const saved = await restart.execute({ action: 'status' })
    assert.equal(saved.cameras.filter(camera => camera.outputPath).length, 2)
    f.outputs.get(filters[0])!.active = true
    await f.service.execute({ action: 'stop', runId: start.runId!, requestId: 'stop-again' })
    assert.equal(f.outputs.get(filters[0])!.active, true)
    assert.equal(f.vendor('record_stop').length, 2)
  } finally {
    await f.cleanup()
  }
})

test('live stream and other unrelated outputs do not prevent independent recording', async () => {
  const f = await fixture()
  try {
    f.outputs.set('simple_stream', { active: true, duration: 10, path: '/unused/stream.mov' })
    const started = await f.service.execute({ action: 'start', requestId: 'live-start' })
    assert.equal(started.ok, true)
    assert.equal(started.running, true)
    const status = await f.service.execute({ action: 'status' })
    assert.equal(status.ok, true)
    assert.equal(status.ready, true)
    assert.equal(f.outputs.get('simple_stream')!.active, true)
  } finally {
    await f.cleanup()
  }
})

test('CSV index escapes labels and protects formula-like values while manifest preserves exact label', async () => {
  const f = await fixture()
  try {
    const start = await f.service.execute({ action: 'start', requestId: 'csv' })
    const marked = await f.service.execute({
      action: 'mark',
      runId: start.runId!,
      requestId: 'csv-mark',
      label: '=HYPERLINK("bad"),补货',
    })
    assert.match(marked.indexPath!, /\.csv$/)
    const csv = await readFile(marked.indexPath!, 'utf8')
    assert.match(csv, /"'=HYPERLINK\(""bad""\),补货"/)
    const manifest = JSON.parse(await readFile(marked.manifestPath!, 'utf8'))
    assert.equal(manifest.marks[0].label, '=HYPERLINK("bad"),补货')
  } finally {
    await f.cleanup()
  }
})

test('offline queued start remains stoppable and clears only this run pending filter intent', async () => {
  const f = await fixture()
  try {
    const base = f.client.call.bind(f.client)
    f.client.call = async (type, data) => {
      const result = await base(type, data)
      if (type === 'CallVendorRequest' && data?.requestType === 'record_start')
        f.outputs.delete(String((data.requestData as Record<string, unknown>).filter))
      if (type === 'CallVendorRequest' && data?.requestType === 'record_stop')
        f.outputs.delete(String((data.requestData as Record<string, unknown>).filter))
      return result
    }
    const started = await f.service.execute({ action: 'start', requestId: 'offline-start' })
    assert.equal(started.ok, false)
    assert.equal(started.running, true)
    const stopped = await f.service.execute({
      action: 'stop',
      runId: started.runId!,
      requestId: 'offline-stop',
    })
    assert.equal(stopped.ok, true)
    assert.equal(stopped.running, false)
    assert.equal(f.settings.get(filters[0])!.record_mode, 0)
    assert.equal(f.settings.get(filters[1])!.record_mode, 0)
    assert.equal(f.vendor('record_stop').length, 2)
  } finally {
    await f.cleanup()
  }
})

test('a completed run reconnects the next start to the newly configured OBS connection', async () => {
  const f = await fixture()
  try {
    const connections: string[] = []
    f.client.connect = async url => {
      connections.push(url)
    }
    const started = await f.service.execute({ action: 'start', requestId: 'first' })
    await f.service.execute({ action: 'stop', runId: started.runId!, requestId: 'stop-first' })
    f.connection = { url: 'ws://127.0.0.1:5555', password: 'replacement' }
    const next = await f.service.execute({ action: 'start', requestId: 'second' })
    assert.equal(next.ok, true)
    assert.equal(connections.at(-1), 'ws://127.0.0.1:5555')
  } finally {
    await f.cleanup()
  }
})

test('configuration changes during start validation prevent any recording mutation', async () => {
  const f = await fixture()
  try {
    f.onCall = type => {
      if (type === 'GetSceneList') f.config = { ...config, iphoneSource: 'Changed source' }
    }
    const state = await f.service.execute({ action: 'start', requestId: 'racing-config' })
    assert.equal(state.ok, false)
    assert.equal(
      f.calls.some(call => call.type.startsWith('Set') || call.type === 'CallVendorRequest'),
      false,
    )
  } finally {
    await f.cleanup()
  }
})

test('a nonchapter output kind and paused output cannot receive a chapter', async () => {
  for (const mutation of ['kind', 'paused'] as const) {
    const f = await fixture()
    try {
      const started = await f.service.execute({ action: 'start', requestId: 'start' })
      const base = f.client.call.bind(f.client)
      f.client.call = async (type, data) => {
        const response = await base(type, data)
        if (type === 'GetOutputList' && mutation === 'kind')
          return {
            outputs: (response.outputs as Record<string, unknown>[]).map(output => ({
              ...output,
              outputKind: 'flv_output',
            })),
          }
        if (type === 'GetOutputStatus' && mutation === 'paused')
          return { ...response, outputPaused: true }
        return response
      }
      const marked = await f.service.execute({
        action: 'mark',
        runId: started.runId!,
        requestId: mutation,
      })
      assert.equal(marked.ok, false)
      assert.equal(f.vendor('record_add_chapter').length, 0)
    } finally {
      await f.cleanup()
    }
  }
})

test('file rebuilding before or after delivery never confirms a chapter against the previous file', async () => {
  for (const changeAt of ['before', 'after'] as const) {
    const f = await fixture()
    try {
      const started = await f.service.execute({ action: 'start', requestId: 'start' })
      let reads = 0
      f.onCall = (type, data) => {
        if (
          (changeAt === 'before' && type === 'GetOutputSettings' && ++reads === 2) ||
          (changeAt === 'after' &&
            type === 'CallVendorRequest' &&
            data?.requestType === 'record_add_chapter')
        )
          f.outputs.get(filters[0])!.path = path.join(f.directory, 'rebuilt.mov')
      }
      const marked = await f.service.execute({
        action: 'mark',
        runId: started.runId!,
        requestId: changeAt,
      })
      assert.equal(marked.ok, false)
      assert.equal(marked.marks[0].status, changeAt === 'before' ? 'failed' : 'unconfirmed')
      assert.equal(f.vendor('record_add_chapter').length, changeAt === 'before' ? 0 : 1)
    } finally {
      await f.cleanup()
    }
  }
})

test('temporary output disappearance remains stoppable until the owned filter leaves record mode', async () => {
  const f = await fixture()
  try {
    const started = await f.service.execute({ action: 'start', requestId: 'start' })
    f.outputs.clear()
    const status = await f.service.execute({ action: 'status' })
    assert.equal(status.running, true)
    const stopped = await f.service.execute({
      action: 'stop',
      runId: started.runId!,
      requestId: 'stop-gap',
    })
    assert.equal(stopped.ok, true)
    assert.equal(stopped.running, false)
    assert.equal(f.vendor('record_stop').length, 2)
    assert.equal(f.settings.get(filters[0])!.record_mode, 0)
    assert.equal(f.settings.get(filters[1])!.record_mode, 0)
  } finally {
    await f.cleanup()
  }
})
