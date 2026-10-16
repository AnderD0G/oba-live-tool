import { createHash, randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { OBS_WELCOME_PRESETS, welcomePreset } from '../../../../shared/obsWelcome'
import type { EffectAsset, EffectGroupJob, EffectGroupResource, EffectGroupSpec, EffectOwnedIdentity } from '../../../../shared/effectGroups'
import type { ObsRpcClient } from '../ObsWebSocketClient'

type Data = Record<string, unknown>
type Scene = { sceneName: string; sceneUuid: string }
type SourceItem = { sourceName: string; sourceUuid: string; sceneItemId: number; sceneItemEnabled: boolean; isGroup: boolean; inputKind?: string }
type LocatedItem = SourceItem & { container: Scene; path: string[] }
type SourceSettings = { inputKind: string; inputSettings: Data; filters: Data[]; transform: Data; durationMs: number }
interface Playback {
  resource: EffectGroupResource
  token: string
  controller: AbortController
  timer?: ReturnType<typeof setTimeout>
  wake?: () => void
  completion?: Promise<void>
  cleanup?: Promise<void>
  pendingChannels: Set<string>
  parentPending: boolean
  maskPending: boolean
}
export interface ObsEffectGroupPlayerOptions {
  client: ObsRpcClient
  connect: () => Promise<unknown>
  overlayBaseUrl: string | (() => string)
  installId: string
  /** Optional local-file metadata probe. It must not mutate the source; results are bounded to two seconds. */
  durationProbe?: (file: string) => Promise<number>
  /** This callback must durably commit to SQLite before it resolves. */
  onResource: (resource: EffectGroupResource) => void | Promise<void>
}
export interface EffectGroupSyncContext { accountId: string; targetSceneName: string; generation?: number }
const REALM = 'OBS_WEBSOCKET_DATA_REALM_GLOBAL'
const MASK_KIND = 'color_filter_v2'
const ACTION_LABELS = { enter: '进场欢迎', follow: '关注感谢', like: '点赞感谢', gift: '送礼感谢' } as const
const FILTER_KINDS = new Set(['chroma_key_filter', 'chroma_key_filter_v2', 'color_key_filter', 'color_key_filter_v2', 'color_filter', 'color_filter_v2', 'crop_filter', 'mask_filter', 'mask_filter_v2', 'sharpness_filter', 'sharpness_filter_v2'])
const MEDIA_SETTINGS = ['local_file', 'is_local_file', 'looping', 'restart_on_activate', 'close_when_inactive', 'clear_on_media_end', 'hw_decode', 'buffering_mb', 'speed_percent', 'linear_alpha', 'color_range', 'seekable']
const BROWSER_SETTINGS = ['url', 'width', 'height', 'fps', 'custom_fps', 'shutdown', 'restart_when_active', 'reroute_audio', 'css']
const TRANSFORM_SETTINGS = ['positionX', 'positionY', 'rotation', 'scaleX', 'scaleY', 'alignment', 'boundsType', 'boundsAlignment', 'boundsWidth', 'boundsHeight', 'cropLeft', 'cropRight', 'cropTop', 'cropBottom']
function pick(value: Data, keys: readonly string[]) { return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]])) }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
function hash(value: unknown) { return createHash('sha256').update(canonical(value)).digest('hex') }
function message(error: unknown) { return error instanceof Error ? error.message : String(error) }
function storedError(error: unknown) { return message(error).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 1000) }
function isNameCollision(error: unknown) { return /already exists|duplicate|已存在|\b601\b/i.test(message(error)) }
function fail(code: string, detail: string) { return Object.assign(new Error(detail), { code }) }
function resourceKey(resource: EffectGroupResource) { return `${resource.accountId}/${resource.groupId}/${resource.generation}` }
function projection(settings: Data, kind: string) { return pick(settings, kind === 'browser_source' ? BROWSER_SETTINGS : MEDIA_SETTINGS) }
function maskHash(filter: Data) { return hash({ filterKind: filter.filterKind, filterSettings: filter.filterSettings }) }
function snapshot(spec: EffectGroupSpec): EffectGroupSpec {
  const { groupId, audienceRuleId, actionKind, enabled, slot, concurrency, priority, durationMs, animations, caption, coalesce } = spec
  return structuredClone({ groupId, audienceRuleId, actionKind, enabled, slot, concurrency, priority, durationMs, animations, caption, coalesce })
}

/** Independent OBS sources, durable create intents, and UUID-checked cleanup. */
export class ObsEffectGroupPlayer {
  private resources = new Map<string, EffectGroupResource>()
  private active = new Map<string, Playback>()
  private cleanupPending = new Map<string, Playback>()
  private controls = new Map<string, Promise<unknown>>()
  private stopping = false
  private stopWork?: Promise<void>
  private epoch = 0
  constructor(private options: ObsEffectGroupPlayerOptions) {
    if (!options.installId) throw new Error('An installation identity is required')
  }
  private get client() { return this.options.client }
  private async persist(resource: EffectGroupResource) {
    await this.options.onResource(structuredClone(resource))
    this.resources.set(resourceKey(resource), resource)
  }
  private async inventory() {
    const scenes = await this.client.call('GetSceneList')
    const inputs = await this.client.call('GetInputList')
    return {
      scenes: (Array.isArray(scenes.scenes) ? scenes.scenes : []) as Scene[],
      inputs: (Array.isArray(inputs.inputs) ? inputs.inputs : []) as { inputName: string; inputUuid: string; inputKind: string }[],
    }
  }
  private async items(scene: Scene, group = false): Promise<SourceItem[]> {
    const result = await this.client.call(group ? 'GetGroupSceneItemList' : 'GetSceneItemList', { sceneUuid: scene.sceneUuid })
    const items = Array.isArray(result.sceneItems) ? result.sceneItems as SourceItem[] : []
    if (items.some(item => !item.sourceUuid || typeof item.sceneItemId !== 'number'))
      throw fail('OBS_UUID_REQUIRED', 'OBS must provide source UUIDs for safe resource ownership')
    return items
  }
  private async traverse(targetSceneName: string) {
    const { scenes } = await this.inventory()
    const root = scenes.find(scene => scene.sceneName === targetSceneName)
    if (!root?.sceneUuid) throw fail('SCENE_MISSING', 'The selected OBS scene is missing or has no UUID')
    const result: LocatedItem[] = []
    let nodes = 0
    const walk = async (scene: Scene, isGroup: boolean, ancestry: Set<string>, path: string[]) => {
      if (ancestry.has(scene.sceneUuid)) throw fail('SCENE_CYCLE', `OBS scene cycle: ${path.join(' / ')}`)
      if (path.length > 16 || ++nodes > 512) throw fail('SCENE_LIMIT', `OBS recursion limit: ${path.join(' / ')}`)
      const next = new Set(ancestry).add(scene.sceneUuid)
      for (const item of await this.items(scene, isGroup)) {
        if (++nodes > 2048) throw fail('SCENE_LIMIT', 'OBS scene node limit exceeded')
        const itemPath = [...path, item.sourceName]
        result.push({ ...item, container: scene, path: itemPath })
        const nested = scenes.find(candidate => candidate.sceneUuid === item.sourceUuid)
        if (item.isGroup || nested || item.inputKind === 'scene' || item.inputKind === 'group')
          await walk(nested || { sceneName: item.sourceName, sceneUuid: item.sourceUuid }, item.isGroup, next, itemPath)
      }
    }
    await walk(root, false, new Set(), [root.sceneName])
    return { root, items: result }
  }
  private async readMedia(item: LocatedItem): Promise<SourceSettings> {
    const input = await this.client.call('GetInputSettings', { inputUuid: item.sourceUuid })
    const settings = input.inputSettings as Data | undefined
    if (input.inputKind !== 'ffmpeg_source' || typeof settings?.local_file !== 'string' || !(await stat(settings.local_file).catch(() => undefined))?.isFile())
      throw fail('ASSET_UNAVAILABLE', 'Welcome media must reference an existing local ffmpeg video file')
    const status = await this.client.call('GetMediaInputStatus', { inputUuid: item.sourceUuid }).catch(() => ({} as Data))
    let durationMs = Number(status.mediaDuration)
    if (!(Number.isFinite(durationMs) && durationMs > 0) && this.options.durationProbe) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        durationMs = await Promise.race([this.options.durationProbe(settings.local_file), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(fail('DURATION_UNKNOWN', 'Local media duration probe timed out')), 2000) })])
      } finally { if (timer) clearTimeout(timer) }
    }
    if (!Number.isFinite(durationMs) || durationMs <= 0) throw fail('DURATION_UNKNOWN', 'Actual media duration is unavailable while the source is unloaded')
    durationMs = Math.ceil(durationMs)
    if (durationMs > 10000) throw fail('DURATION_TOO_LONG', 'Actual media duration exceeds the supported ten-second common window')
    const response = await this.client.call('GetSourceFilterList', { sourceUuid: item.sourceUuid })
    const filters = (Array.isArray(response.filters) ? response.filters : []) as Data[]
    if (!filters.some(filter => ['chroma_key_filter', 'chroma_key_filter_v2'].includes(String(filter.filterKind)) && filter.filterEnabled === true))
      throw fail('FILTER_UNAVAILABLE', 'Welcome media requires an enabled chroma key filter')
    if (filters.some(filter => !FILTER_KINDS.has(String(filter.filterKind))))
      throw fail('FILTER_UNSUPPORTED', 'A source filter cannot safely be cloned')
    const complete: Data[] = []
    for (const filter of filters) {
      if (typeof filter.filterName !== 'string') throw fail('FILTER_UNAVAILABLE', 'Source filter identity is missing')
      const detail = await this.client.call('GetSourceFilter', { sourceUuid: item.sourceUuid, filterName: filter.filterName })
      complete.push({ ...filter, ...detail })
    }
    const transform = await this.client.call('GetSceneItemTransform', { sceneUuid: item.container.sceneUuid, sceneItemId: item.sceneItemId })
    return { inputKind: 'ffmpeg_source', inputSettings: { ...pick(settings, MEDIA_SETTINGS), is_local_file: true, looping: false, restart_on_activate: false, close_when_inactive: false, clear_on_media_end: false }, filters: complete, transform: pick((transform.sceneItemTransform || {}) as Data, TRANSFORM_SETTINGS), durationMs }
  }
  async catalog(targetSceneName: string): Promise<EffectAsset[]> {
    await this.options.connect()
    let tree: Awaited<ReturnType<ObsEffectGroupPlayer['traverse']>>
    try { tree = await this.traverse(targetSceneName); this.overlayUrl('catalog-test') }
    catch (error) { return OBS_WELCOME_PRESETS.map(preset => ({ ...preset, available: false, reason: message(error) })) }
    const result: EffectAsset[] = []
    for (const preset of OBS_WELCOME_PRESETS) {
      if (preset.kind === 'html') { result.push({ ...preset, available: true }); continue }
      const matches = tree.items.filter(item => item.sourceName === preset.sourceName)
      try {
        if (matches.length !== 1) throw fail('ASSET_PATH_CONFLICT', matches.length ? 'The source has multiple OBS paths' : 'The source is absent from the selected scene')
        const source = await this.readMedia(matches[0])
        result.push({ ...preset, durationMs: Math.max(preset.durationMs, source.durationMs), available: true, sourceUuid: matches[0].sourceUuid, sourceContainerName: matches[0].container.sceneName, sourceContainerUuid: matches[0].container.sceneUuid, inputKind: source.inputKind, settingsHash: hash(source) })
      } catch (error) { result.push({ ...preset, available: false, reason: message(error) }) }
    }
    return result
  }
  private overlayUrl(channel: string) {
    const base = typeof this.options.overlayBaseUrl === 'function' ? this.options.overlayBaseUrl() : this.options.overlayBaseUrl
    const url = new URL('/obs/instant/welcome.html', base)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password)
      throw fail('OVERLAY_URL', 'Group browser overlays require the local native overlay server')
    url.search = new URLSearchParams({ transport: 'native', channel, mode: 'wide' }).toString()
    return url.toString()
  }
  private channel(resource: EffectGroupResource, suffix: string) { return `oba.group/${resource.groupId}/${resource.generation}/${suffix}` }
  private marker(resource: EffectGroupResource, identity: EffectOwnedIdentity) {
    return { installId: resource.installId, accountId: resource.accountId, groupId: resource.groupId, generation: resource.generation, intentId: identity.intentId, kind: identity.kind, name: identity.name, uuid: identity.uuid ?? null }
  }
  private async getMarker(identity: EffectOwnedIdentity) {
    if (!identity.markerKey) throw fail('OWNERSHIP_CONFLICT', 'The durable ownership marker is missing')
    return (await this.client.call('GetPersistentData', { realm: REALM, slotName: identity.markerKey })).slotValue
  }
  private async putMarker(resource: EffectGroupResource, identity: EffectOwnedIdentity) {
    await this.client.call('SetPersistentData', { realm: REALM, slotName: identity.markerKey, slotValue: this.marker(resource, identity) })
  }
  private async requireMarker(resource: EffectGroupResource, identity: EffectOwnedIdentity, allowUnbound = false) {
    if (resource.installId !== this.options.installId || !identity.intentId || !identity.uuid && !allowUnbound)
      throw fail('OWNERSHIP_CONFLICT', 'The resource has no durable UUID ownership proof')
    const observed = await this.getMarker(identity) as Data | null
    const expected = this.marker(resource, identity)
    if (!observed || Object.entries(expected).some(([key, value]) => key === 'uuid' && allowUnbound ? observed.uuid !== null && observed.uuid !== identity.uuid : observed[key] !== value))
      throw fail('OWNERSHIP_CONFLICT', 'OBS resource ownership marker does not match the SQLite intent')
  }
  private newIdentity(resource: EffectGroupResource, kind: EffectOwnedIdentity['kind'], name: string): EffectOwnedIdentity {
    const intentId = randomUUID()
    return { kind, name, intentId, markerKey: `oba.effect-group.${resource.installId}.${intentId}`, created: false }
  }
  private async createOwned(resource: EffectGroupResource, identity: EffectOwnedIdentity, requestType: 'CreateScene' | 'CreateInput', data: Data, expectedSettings?: Data) {
    let inventory = await this.inventory()
    let existing = requestType === 'CreateScene' ? inventory.scenes.find(scene => scene.sceneName === identity.name) : inventory.inputs.find(input => input.inputName === identity.name)
    if (identity.uuid) { await this.requireMarker(resource, identity); return }
    if (!identity.created) {
      if (existing) throw fail('OWNERSHIP_CONFLICT', 'A same-name OBS source exists without our durable ownership intent')
      const prior = await this.getMarker(identity)
      if (prior !== null) throw fail('OWNERSHIP_CONFLICT', 'Another owner already claims the OBS creation intent')
      await this.putMarker(resource, identity)
      identity.created = true
      await this.persist(resource)
      try {
        const receipt = await this.client.call(requestType, data)
        identity.uuid = String(receipt[requestType === 'CreateScene' ? 'sceneUuid' : 'inputUuid'] || '') || undefined
        if (typeof receipt.sceneItemId === 'number') identity.itemId = receipt.sceneItemId
      } catch (error) {
        if (isNameCollision(error)) throw fail('OWNERSHIP_CONFLICT', 'OBS reported a name collision; the existing source belongs to another owner')
        // A failed reply is not proof that OBS did not create the source. Read before any retry.
        inventory = await this.inventory()
        existing = requestType === 'CreateScene' ? inventory.scenes.find(scene => scene.sceneName === identity.name) : inventory.inputs.find(input => input.inputName === identity.name)
        if (!existing) throw error
      }
    }
    if (!identity.uuid) {
      await this.requireMarker(resource, identity, true)
      inventory = await this.inventory()
      existing = requestType === 'CreateScene' ? inventory.scenes.find(scene => scene.sceneName === identity.name) : inventory.inputs.find(input => input.inputName === identity.name)
      if (!existing) {
        // OBS rejects duplicate source names. Reuse the exact persisted intent,
        // after observing absence, rather than allocating another identity.
        try {
          const receipt = await this.client.call(requestType, data)
          if (typeof receipt.sceneItemId === 'number') identity.itemId = receipt.sceneItemId
        } catch (error) {
          if (isNameCollision(error)) throw fail('OWNERSHIP_CONFLICT', 'OBS reported a name collision; the existing source belongs to another owner')
          const reconciled = await this.inventory()
          const exists = requestType === 'CreateScene' ? reconciled.scenes.some(scene => scene.sceneName === identity.name) : reconciled.inputs.some(input => input.inputName === identity.name)
          if (!exists) throw error
        }
        inventory = await this.inventory()
        existing = requestType === 'CreateScene' ? inventory.scenes.find(scene => scene.sceneName === identity.name) : inventory.inputs.find(input => input.inputName === identity.name)
        if (!existing) throw fail('CREATE_UNCERTAIN', 'OBS did not confirm the persisted creation intent')
      }
      identity.uuid = 'sceneUuid' in existing ? existing.sceneUuid : existing.inputUuid
      if (requestType === 'CreateInput') {
        const observed = await this.client.call('GetInputSettings', { inputUuid: identity.uuid })
        if (observed.inputKind !== data.inputKind || Object.entries(expectedSettings || {}).some(([key, value]) => canonical((observed.inputSettings as Data)?.[key]) !== canonical(value))) {
          identity.uuid = undefined
          throw fail('OWNERSHIP_CONFLICT', 'The uncertain input does not match the persisted creation settings')
        }
        const members = (await this.items({ sceneName: resource.sceneName, sceneUuid: resource.sceneUuid! })).filter(item => item.sourceUuid === identity.uuid)
        if (members.length !== 1) throw fail('OWNERSHIP_CONFLICT', 'The uncertain input has unexpected OBS scene references')
        identity.itemId = members[0].sceneItemId
      }
    }
    if (!identity.uuid) throw fail('OBS_UUID_REQUIRED', 'OBS create did not return a resource UUID')
    await this.putMarker(resource, identity)
    await this.persist(resource)
  }
  sync(group: EffectGroupSpec & Partial<EffectGroupSyncContext>, label: string, previous?: EffectGroupResource, context?: EffectGroupSyncContext): Promise<EffectGroupResource> {
    const accountId = context?.accountId || group.accountId || previous?.accountId
    const targetSceneName = context?.targetSceneName || group.targetSceneName || previous?.parentSceneName
    if (!accountId || !targetSceneName) return Promise.reject(fail('SYNC_CONTEXT', 'OBS resource synchronization requires an account and selected scene'))
    const key = `${accountId}/${group.groupId}`
    const work = (this.controls.get(key) || Promise.resolve()).catch(() => {}).then(() => this.syncNow(group, label, previous, { accountId, targetSceneName, generation: context?.generation }))
    this.controls.set(key, work)
    void work.finally(() => { if (this.controls.get(key) === work) this.controls.delete(key) }).catch(() => {})
    return work
  }
  private async syncNow(group: EffectGroupSpec, label: string, previous: EffectGroupResource | undefined, context: EffectGroupSyncContext) {
    if (this.stopping) throw fail('PLAYER_STOPPED', 'OBS group player has stopped')
    await this.options.connect()
    if (group.animations.length < 1 || group.animations.length > 3 || !Number.isInteger(group.durationMs) || group.durationMs < 1000 || group.durationMs > 10000)
      throw fail('GROUP_INVALID', 'Effect groups require 1–3 animations and a common 1–10 second window')
    for (const animation of group.animations)
      if (group.durationMs < welcomePreset(animation.assetId).durationMs) throw fail('DURATION_TOO_SHORT', 'The common window would truncate the selected asset')
    const configHash = hash({ group: snapshot(group), targetSceneName: context.targetSceneName })
    const known = [...this.resources.values()].filter(resource => resource.accountId === context.accountId && resource.groupId === group.groupId).sort((a, b) => b.generation - a.generation)[0]
    let resource = known && (!previous || known.generation >= previous.generation) ? known : previous && structuredClone(previous)
    let regenerate = false
    if (resource?.configHash === configHash && resource.state === 'ready') {
      try { await this.validate(resource) }
      catch (error) {
        if ((error as { code?: string }).code !== 'OWNED_RESOURCE_MISSING' || this.active.has(resourceKey(resource))) throw error
        regenerate = true; resource.state = 'failed'; resource.error = storedError(error); await this.persist(resource)
      }
      if (!regenerate) {
        if (resource.label !== label) { resource.label = label; await this.persist(resource) }
        return structuredClone(resource)
      }
    }
    if (resource && this.cleanupPending.has(resourceKey(resource))) throw fail('CLEANUP_FAILED', 'Resource cleanup is unresolved; synchronization is quarantined')
    const tree = await this.traverse(context.targetSceneName)
    if (!resource || regenerate || resource.configHash !== configHash || ['retiring', 'conflict'].includes(resource.state)) {
      const generation = Math.max(context.generation || 1, (resource?.generation || 0) + 1), nonce = randomUUID()
      const prefix = `OBA.G.${group.groupId}.${generation}.${nonce}`
      const displayLabel = Array.from(label.replace(/[\u0000-\u001f\u007f-\u009f/\\]/g, ' ').replace(/\s+/g, ' ').trim() || group.audienceRuleId).slice(0, 40).join('')
      resource = { accountId: context.accountId, groupId: group.groupId, generation, installId: this.options.installId,
        sceneName: `${displayLabel} · ${ACTION_LABELS[group.actionKind]} · ${prefix}.scene`.slice(0, 200), parentSceneName: tree.root.sceneName, parentSceneUuid: tree.root.sceneUuid,
        captionInputName: `${prefix}.caption`, animationInputs: group.animations.map((animation, index) => ({ assetId: animation.assetId, inputName: `${prefix}.anim.${index}`, kind: welcomePreset(animation.assetId).kind })),
        state: 'pending', configHash, label, creationNonce: nonce, ownedIdentities: [], snapshot: snapshot(group) }
      resource.ownedIdentities.push(this.newIdentity(resource, 'scene', resource.sceneName), this.newIdentity(resource, 'input', resource.captionInputName), ...resource.animationInputs.map(input => this.newIdentity(resource!, 'input', input.inputName)))
      await this.persist(resource)
    }
    if (resource.parentSceneUuid !== tree.root.sceneUuid) throw fail('OWNERSHIP_CONFLICT', 'The selected parent scene UUID changed')
    try {
      const video = await this.client.call('GetVideoSettings'), width = Number(video.baseWidth), height = Number(video.baseHeight)
      if (!(width > 0 && height > 0)) throw fail('VIDEO_SETTINGS', 'OBS canvas dimensions are unavailable')
      const sources: (SourceSettings | undefined)[] = []
      for (const animation of group.animations) {
        const preset = welcomePreset(animation.assetId)
        if (preset.kind === 'html') { sources.push(undefined); continue }
        const matches = tree.items.filter(item => item.sourceName === preset.sourceName)
        if (matches.length !== 1) throw fail('ASSET_PATH_CONFLICT', 'Media source must have one unambiguous path in the selected scene')
        const source = await this.readMedia(matches[0])
        if (source.durationMs > group.durationMs) throw fail('DURATION_TOO_SHORT', 'The common duration would truncate the actual media clip')
        sources.push(source)
      }
      const sceneIdentity = resource.ownedIdentities.find(identity => identity.kind === 'scene')!
      await this.createOwned(resource, sceneIdentity, 'CreateScene', { sceneName: resource.sceneName })
      resource.sceneUuid = sceneIdentity.uuid
      await this.persist(resource)
      await this.ensureMask(resource)
      const browser = (suffix: string): Data => ({ url: this.overlayUrl(this.channel(resource!, suffix)), width, height, fps: 30, custom_fps: true, shutdown: false, restart_when_active: false, reroute_audio: false })
      const members = [{ name: resource.captionInputName, settings: browser('caption'), source: undefined as SourceSettings | undefined },
        ...resource.animationInputs.map((input, index) => ({ name: input.inputName, settings: sources[index]?.inputSettings || browser(`anim/${index}`), source: sources[index] }))]
      for (let index = 0; index < members.length; index++) {
        const member = members[index], identity = resource.ownedIdentities.find(candidate => candidate.kind === 'input' && candidate.name === member.name)!
        identity.parentUuid = resource.sceneUuid
        await this.createOwned(resource, identity, 'CreateInput', { sceneUuid: resource.sceneUuid, inputName: member.name, inputKind: member.source?.inputKind || 'browser_source', inputSettings: member.settings, sceneItemEnabled: true }, member.settings)
        if (!identity.settingsHash) {
          await this.requireMarker(resource, identity)
          await this.client.call('SetInputMute', { inputUuid: identity.uuid, inputMuted: true })
          if (member.source) {
            const filters = (await this.client.call('GetSourceFilterList', { sourceUuid: identity.uuid })).filters as Data[] || []
            for (const filter of member.source.filters) {
              const existing = filters.find(candidate => candidate.filterName === filter.filterName)
              if (existing && (existing.filterKind !== filter.filterKind || hash(existing.filterSettings) !== hash(filter.filterSettings)))
                throw fail('OWNERSHIP_CONFLICT', 'A cloned filter has been modified externally')
              if (!existing) await this.client.call('CreateSourceFilter', { sourceUuid: identity.uuid, filterName: filter.filterName, filterKind: filter.filterKind, filterSettings: filter.filterSettings || {} })
              await this.client.call('SetSourceFilterEnabled', { sourceUuid: identity.uuid, filterName: filter.filterName, filterEnabled: filter.filterEnabled })
              await this.client.call('SetSourceFilterIndex', { sourceUuid: identity.uuid, filterName: filter.filterName, filterIndex: filter.filterIndex })
            }
          }
          const transform = member.source ? this.mediaTransform(member.source.transform, group, index - 1, width, height) : { positionX: 0, positionY: 0, scaleX: 1, scaleY: 1 }
          await this.client.call('SetSceneItemTransform', { sceneUuid: resource.sceneUuid, sceneItemId: identity.itemId, sceneItemTransform: transform })
          const placed = await this.client.call('GetSceneItemTransform', { sceneUuid: resource.sceneUuid, sceneItemId: identity.itemId })
          identity.transformHash = hash(pick(placed.sceneItemTransform as Data, TRANSFORM_SETTINGS))
          const actual = await this.client.call('GetInputSettings', { inputUuid: identity.uuid })
          identity.settingsHash = hash(projection(actual.inputSettings as Data, String(actual.inputKind)))
          const filters = await this.client.call('GetSourceFilterList', { sourceUuid: identity.uuid })
          resource.ownedIdentities.push({ kind: 'filter', parentUuid: identity.uuid, settingsHash: hash(filters.filters || []) })
          await this.persist(resource)
        }
        if (index === 0) { resource.captionInputUuid = identity.uuid; resource.captionSettingsHash = identity.settingsHash }
        else { resource.animationInputs[index - 1].inputUuid = identity.uuid; resource.animationInputs[index - 1].settingsHash = identity.settingsHash }
      }
      await this.placeCaptionTop(resource)
      let parentIdentity = resource.ownedIdentities.find(identity => identity.kind === 'scene-item')
      if (!parentIdentity) { parentIdentity = this.newIdentity(resource, 'scene-item', resource.sceneName); parentIdentity.uuid = resource.sceneUuid; parentIdentity.parentUuid = resource.parentSceneUuid; resource.ownedIdentities.push(parentIdentity); await this.persist(resource) }
      if (parentIdentity.itemId === undefined) {
        const matches = (await this.items(tree.root)).filter(item => item.sourceUuid === resource!.sceneUuid)
        if (matches.length > 1 || matches.length === 1 && !parentIdentity.created) throw fail('OWNERSHIP_CONFLICT', 'Unexpected references to the private group scene')
        if (!parentIdentity.created) { await this.putMarker(resource, parentIdentity); parentIdentity.created = true; await this.persist(resource) }
        if (matches.length === 1) parentIdentity.itemId = matches[0].sceneItemId
        else {
          try { parentIdentity.itemId = (await this.client.call('CreateSceneItem', { sceneUuid: tree.root.sceneUuid, sourceUuid: resource.sceneUuid, sceneItemEnabled: false })).sceneItemId as number }
          catch (error) { const reconciled = (await this.items(tree.root)).filter(item => item.sourceUuid === resource!.sceneUuid); if (reconciled.length !== 1) throw error; parentIdentity.itemId = reconciled[0].sceneItemId }
        }
        await this.persist(resource)
      }
      resource.parentItemId = parentIdentity.itemId
      if (!parentIdentity.transformHash) {
        const parentTransform = await this.client.call('GetSceneItemTransform', { sceneUuid: resource.parentSceneUuid, sceneItemId: resource.parentItemId })
        parentIdentity.transformHash = hash(pick(parentTransform.sceneItemTransform as Data, TRANSFORM_SETTINGS))
      }
      resource.state = 'ready'; resource.error = undefined; resource.label = label
      await this.validate(resource)
      await this.persist(resource)
      return structuredClone(resource)
    } catch (error) {
      resource.state = (error as { code?: string }).code === 'OWNERSHIP_CONFLICT' ? 'conflict' : 'failed'
      resource.error = storedError(error)
      await this.persist(resource)
      throw error
    }
  }
  private async references(uuids: Set<string>) {
    const inventory = await this.inventory(), result: LocatedItem[] = []
    const groupNames = await this.client.call('GetGroupList')
    const groups = Array.isArray(groupNames.groups) ? groupNames.groups as string[] : []
    const containers: (Scene & { group?: boolean })[] = [...inventory.scenes]
    // Native group UUIDs are discovered from scene items, not guessed from their names.
    for (let index = 0; index < containers.length; index++) {
      if (index > 512) throw fail('SCENE_LIMIT', 'OBS reference scan exceeded the scene limit')
      const container = containers[index]
      for (const item of await this.items(container, !!container.group)) {
        if (uuids.has(item.sourceUuid)) result.push({ ...item, container, path: [container.sceneName, item.sourceName] })
        if (item.isGroup && groups.includes(item.sourceName) && !containers.some(scene => scene.sceneUuid === item.sourceUuid))
          containers.push({ sceneName: item.sourceName, sceneUuid: item.sourceUuid, group: true })
      }
    }
    return result
  }
  private maskIdentity(resource: EffectGroupResource) {
    return resource.ownedIdentities.find(identity => identity.kind === 'filter' && identity.parentUuid === resource.sceneUuid && identity.name)
  }
  private async placeCaptionTop(resource: EffectGroupResource) {
    const scene = resource.ownedIdentities.find(identity => identity.kind === 'scene' && identity.uuid === resource.sceneUuid)
    const caption = resource.ownedIdentities.find(identity => identity.kind === 'input' && identity.uuid === resource.captionInputUuid)
    if (!scene || !caption || caption.itemId === undefined) throw fail('OWNERSHIP_CONFLICT', 'Caption layer is missing its durable source and item identity')
    await this.requireMarker(resource, scene)
    const identities = resource.ownedIdentities.filter(identity => identity.kind === 'input')
    const members = await this.items({ sceneName: resource.sceneName, sceneUuid: resource.sceneUuid! })
    if (members.length !== identities.length || identities.some(identity => !members.some(member => member.sourceUuid === identity.uuid && member.sceneItemId === identity.itemId)))
      throw fail('OWNERSHIP_CONFLICT', 'The private scene changed before caption placement')
    for (const identity of identities) await this.requireMarker(resource, identity)
    const data = { sceneUuid: resource.sceneUuid, sceneItemId: caption.itemId }, top = resource.animationInputs.length
    if ((await this.client.call('GetSceneItemIndex', data)).sceneItemIndex === top) return
    try { await this.client.call('SetSceneItemIndex', { ...data, sceneItemIndex: top }) }
    catch (error) {
      if ((await this.client.call('GetSceneItemIndex', data)).sceneItemIndex !== top) throw error
      return
    }
    if ((await this.client.call('GetSceneItemIndex', data)).sceneItemIndex !== top)
      throw fail('OWNERSHIP_CONFLICT', 'OBS did not acknowledge the caption at the top layer index')
  }
  private async ensureMask(resource: EffectGroupResource) {
    let identity = this.maskIdentity(resource)
    if (!identity) {
      identity = this.newIdentity(resource, 'filter', `OBA.G.${resource.groupId}.${resource.generation}.${resource.creationNonce}.mask`)
      // OBS filters have no public UUID. Bind their unique intent/name to the
      // acknowledged private scene UUID, with an independent ownership marker.
      identity.uuid = resource.sceneUuid; identity.parentUuid = resource.sceneUuid
      resource.ownedIdentities.push(identity); await this.persist(resource)
    }
    let filters = (await this.client.call('GetSourceFilterList', { sourceUuid: resource.sceneUuid })).filters as Data[] || []
    let filter = filters.find(candidate => candidate.filterName === identity!.name)
    if (filters.some(candidate => candidate.filterName !== identity!.name)) throw fail('OWNERSHIP_CONFLICT', 'The private scene has an external filter')
    if (!identity.created) {
      if (filter || await this.getMarker(identity) !== null) throw fail('OWNERSHIP_CONFLICT', 'A private opacity filter exists without our creation intent')
      await this.putMarker(resource, identity); identity.created = true; await this.persist(resource)
    }
    await this.requireMarker(resource, identity)
    if (!filter) {
      if (identity.settingsHash) throw fail('OWNED_RESOURCE_MISSING', 'The acknowledged private opacity filter is missing')
      try { await this.client.call('CreateSourceFilter', { sourceUuid: resource.sceneUuid, filterName: identity.name, filterKind: MASK_KIND, filterSettings: { opacity: 0 } }) }
      catch (error) {
        if (isNameCollision(error)) throw fail('OWNERSHIP_CONFLICT', 'OBS reported a private filter name collision')
        filters = (await this.client.call('GetSourceFilterList', { sourceUuid: resource.sceneUuid })).filters as Data[] || []
        if (!filters.some(candidate => candidate.filterName === identity!.name)) throw error
      }
      filter = await this.client.call('GetSourceFilter', { sourceUuid: resource.sceneUuid, filterName: identity.name })
    }
    if (filter.filterKind !== MASK_KIND || (filter.filterSettings as Data)?.opacity !== 0 || identity.settingsHash && maskHash(filter) !== identity.settingsHash)
      throw fail('OWNERSHIP_CONFLICT', 'The private opacity filter differs from its durable intent')
    identity.settingsHash = maskHash(filter)
    await this.client.call('SetSourceFilterEnabled', { sourceUuid: resource.sceneUuid, filterName: identity.name, filterEnabled: true })
    await this.persist(resource)
  }
  private async setMask(resource: EffectGroupResource, enabled: boolean) {
    const identity = this.maskIdentity(resource)
    if (!identity) {
      if (enabled && resource.state === 'retiring') return
      throw fail('OWNED_RESOURCE_MISSING', 'The private opacity gate requires a new resource generation')
    }
    await this.validateMask(resource, identity)
    await this.client.call('SetSourceFilterEnabled', { sourceUuid: resource.sceneUuid, filterName: identity.name, filterEnabled: enabled })
  }
  private async validateMask(resource: EffectGroupResource, identity: EffectOwnedIdentity) {
    if (identity.uuid !== resource.sceneUuid || identity.parentUuid !== resource.sceneUuid) throw fail('OWNERSHIP_CONFLICT', 'The private opacity gate is bound to another source UUID')
    await this.requireMarker(resource, identity)
    const filters = (await this.client.call('GetSourceFilterList', { sourceUuid: resource.sceneUuid })).filters as Data[] || []
    if (filters.length !== 1 || filters[0].filterName !== identity.name || filters[0].filterKind !== MASK_KIND || !identity.settingsHash || maskHash(filters[0]) !== identity.settingsHash || typeof filters[0].filterEnabled !== 'boolean')
      throw fail('OWNERSHIP_CONFLICT', 'The private opacity gate was modified externally')
  }
  private mediaTransform(original: Data, group: EffectGroupSpec, index: number, width: number, height: number): Data {
    const placement = group.slot === 'main-stage' ? group.animations[index].placement : group.slot
    if (placement === 'border' || placement === 'full-screen') return { ...original }
    const corner = placement === 'corner-left' || placement === 'corner-right'
    const scale = corner ? 0.36 : placement === 'center' ? 0.65 : 0.5
    const boundsWidth = width * scale, boundsHeight = height * scale
    return { ...original, scaleX: 1, scaleY: 1, alignment: 5, boundsAlignment: 5, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth, boundsHeight,
      positionX: placement === 'corner-left' ? 24 : placement === 'corner-right' ? width - boundsWidth - 24 : (width - boundsWidth) / 2,
      positionY: placement === 'center' ? (height - boundsHeight) / 2 : height - boundsHeight - 24 }
  }
  private async validate(resource: EffectGroupResource, allowMissing = false) {
    const inventory = await this.inventory()
    const sceneIdentity = resource.ownedIdentities.find(identity => identity.kind === 'scene')
    if (!sceneIdentity || sceneIdentity.uuid !== resource.sceneUuid) throw fail('OWNERSHIP_CONFLICT', 'Private scene identity does not match its durable UUID')
    await this.requireMarker(resource, sceneIdentity)
    const scene = inventory.scenes.find(candidate => candidate.sceneUuid === resource.sceneUuid)
    if (!scene && !allowMissing) throw fail('OWNED_RESOURCE_MISSING', 'The owned scene is missing; it requires a new resource generation')
    if (scene && scene.sceneName !== resource.sceneName) throw fail('OWNERSHIP_CONFLICT', 'The owned scene was renamed externally')
    if (scene) {
      const mask = this.maskIdentity(resource)
      if (!mask && !allowMissing) throw fail('OWNED_RESOURCE_MISSING', 'The private opacity gate requires a new resource generation')
      if (mask) await this.validateMask(resource, mask)
    }
    if (!inventory.scenes.some(candidate => candidate.sceneUuid === resource.parentSceneUuid && candidate.sceneName === resource.parentSceneName)) throw fail('OWNERSHIP_CONFLICT', 'The selected parent scene changed externally')
    const parent = (await this.items({ sceneName: resource.parentSceneName, sceneUuid: resource.parentSceneUuid! })).find(item => item.sceneItemId === resource.parentItemId)
    if (!parent && !allowMissing || parent && parent.sourceUuid !== resource.sceneUuid) throw fail('OWNERSHIP_CONFLICT', 'The owned parent scene item changed externally')
    const parentIdentity = resource.ownedIdentities.find(identity => identity.kind === 'scene-item')
    if (!parentIdentity || parentIdentity.itemId !== resource.parentItemId || parentIdentity.parentUuid !== resource.parentSceneUuid) throw fail('OWNERSHIP_CONFLICT', 'The parent item is missing its durable ownership receipt')
    await this.requireMarker(resource, parentIdentity)
    if (parent && parentIdentity.transformHash) {
      const transform = await this.client.call('GetSceneItemTransform', { sceneUuid: resource.parentSceneUuid, sceneItemId: parent.sceneItemId })
      if (hash(pick(transform.sceneItemTransform as Data, TRANSFORM_SETTINGS)) !== parentIdentity.transformHash) throw fail('OWNERSHIP_CONFLICT', 'The owned parent transform was modified externally')
    }
    const children = scene ? await this.items(scene) : []
    const inputIdentities = resource.ownedIdentities.filter(identity => identity.kind === 'input')
    const allowed = new Set(inputIdentities.map(identity => identity.uuid!))
    if (children.some(item => !allowed.has(item.sourceUuid))) throw fail('OWNERSHIP_CONFLICT', 'The private scene contains externally modified members')
    if (!allowMissing && inputIdentities.some(identity => !inventory.inputs.some(input => input.inputUuid === identity.uuid))) {
      // Validate all markers before replacing any missing acknowledged generation.
      for (const identity of inputIdentities) await this.requireMarker(resource, identity)
      throw fail('OWNED_RESOURCE_MISSING', 'An owned clone is missing; it requires a new resource generation')
    }
    if (!allowMissing && children.length !== inputIdentities.length) throw fail('OWNERSHIP_CONFLICT', 'The private scene contains externally modified members')
    if (!allowMissing && scene) {
      const caption = inputIdentities.find(identity => identity.uuid === resource.captionInputUuid)
      if (!caption || caption.itemId === undefined || (await this.client.call('GetSceneItemIndex', { sceneUuid: resource.sceneUuid, sceneItemId: caption.itemId })).sceneItemIndex !== resource.animationInputs.length)
        throw fail('OWNERSHIP_CONFLICT', 'The caption layer order was modified externally')
    }
    for (const identity of inputIdentities) {
      await this.requireMarker(resource, identity)
      const actual = inventory.inputs.find(input => input.inputUuid === identity.uuid)
      if (!actual && allowMissing) continue
      if (!actual || actual.inputName !== identity.name || !children.some(item => item.sourceUuid === identity.uuid && item.sceneItemId === identity.itemId)) throw fail('OWNERSHIP_CONFLICT', 'An owned input was moved or renamed externally')
      if (identity.transformHash && scene) {
        const transform = await this.client.call('GetSceneItemTransform', { sceneUuid: resource.sceneUuid, sceneItemId: identity.itemId })
        if (hash(pick(transform.sceneItemTransform as Data, TRANSFORM_SETTINGS)) !== identity.transformHash) throw fail('OWNERSHIP_CONFLICT', 'An owned member transform was modified externally')
      }
      const settings = await this.client.call('GetInputSettings', { inputUuid: identity.uuid })
      if (!identity.settingsHash || hash(projection(settings.inputSettings as Data, actual.inputKind)) !== identity.settingsHash) throw fail('OWNERSHIP_CONFLICT', 'An owned input was modified externally')
      const filters = await this.client.call('GetSourceFilterList', { sourceUuid: identity.uuid })
      const filterIdentity = resource.ownedIdentities.find(candidate => candidate.kind === 'filter' && candidate.parentUuid === identity.uuid)
      if (!filterIdentity || hash(filters.filters || []) !== filterIdentity.settingsHash) throw fail('OWNERSHIP_CONFLICT', 'The owned filter configuration changed externally')
      if (!(await this.client.call('GetInputMute', { inputUuid: identity.uuid })).inputMuted) throw fail('OWNERSHIP_CONFLICT', 'An owned input was unmuted externally')
    }
    for (const reference of await this.references(new Set([resource.sceneUuid!, ...allowed]))) {
      const valid = reference.sourceUuid === resource.sceneUuid ? reference.container.sceneUuid === resource.parentSceneUuid && reference.sceneItemId === resource.parentItemId : reference.container.sceneUuid === resource.sceneUuid
      if (!valid) throw fail('OWNERSHIP_CONFLICT', `An owned resource has an external reference: ${reference.path.join(' / ')}`)
    }
  }
  private emit(event: Data) { return this.client.call('CallVendorRequest', { vendorName: 'obs-browser', requestType: 'emit_event', requestData: { event_name: 'oba-instant-effect', event_data: event } }) }
  private nativeChannels(resource: EffectGroupResource) {
    return [this.channel(resource, 'caption'), ...resource.animationInputs.flatMap((input, index) => input.kind === 'html' ? [this.channel(resource, `anim/${index}`)] : [])]
  }
  private async cleanup(playback: Playback) {
    if (playback.cleanup) return playback.cleanup
    playback.cleanup = this.cleanupNow(playback).finally(() => { playback.cleanup = undefined })
    return playback.cleanup
  }
  private async cleanupNow(playback: Playback) {
    if (playback.timer) clearTimeout(playback.timer)
    const resource = playback.resource, errors: unknown[] = []
    try { await this.options.connect(); await this.validate(resource, resource.state === 'retiring') }
    catch (error) { errors.push(error) }
    // Destructive/mutating requests never run when the UUID ownership gate failed.
    if (!errors.length) {
      if (playback.maskPending) {
        try {
          const inventory = await this.inventory()
          if (inventory.scenes.some(scene => scene.sceneUuid === resource.sceneUuid)) await this.setMask(resource, true)
          playback.maskPending = false
        } catch (error) { errors.push(error) }
      }
      if (playback.parentPending) {
        try {
          const parent = (await this.items({ sceneName: resource.parentSceneName, sceneUuid: resource.parentSceneUuid! })).find(item => item.sceneItemId === resource.parentItemId)
          if (parent) await this.client.call('SetSceneItemEnabled', { sceneUuid: resource.parentSceneUuid, sceneItemId: resource.parentItemId, sceneItemEnabled: false })
          playback.parentPending = false
        }
        catch (error) { errors.push(error) }
      }
      for (const channel of [...playback.pendingChannels]) {
        try { await this.emit({ channel, kind: 'welcome', operation: 'clear', token: playback.token, group: true, role: channel.endsWith('/caption') ? 'caption' : 'animation' }); playback.pendingChannels.delete(channel) }
        catch (error) { errors.push(error) }
      }
    }
    if (errors.length) {
      this.cleanupPending.set(resourceKey(resource), playback)
      if (resource.state !== 'retiring') resource.state = errors.some(error => (error as { code?: string }).code === 'OWNERSHIP_CONFLICT') ? 'conflict' : 'failed'
      resource.error = storedError(`Group cleanup failed: ${errors.map(message).join('; ')}`)
      try { await this.persist(resource) } catch (error) { errors.push(error) }
      throw Object.assign(new AggregateError(errors, resource.error), { code: 'CLEANUP_FAILED', cleanupFailed: true })
    }
    const cleanupToken = resource.cleanupToken
    resource.cleanupToken = undefined; resource.error = undefined
    if (resource.state === 'failed') resource.state = 'ready'
    try { await this.persist(resource) }
    catch (error) {
      resource.cleanupToken = cleanupToken
      if (resource.state !== 'retiring') resource.state = 'failed'
      resource.error = storedError(`Group cleanup ledger write failed: ${message(error)}`)
      this.cleanupPending.set(resourceKey(resource), playback)
      try { await this.persist(resource) } catch (persistError) { errors.push(persistError) }
      throw Object.assign(new AggregateError([error, ...errors], resource.error), { code: 'CLEANUP_FAILED', cleanupFailed: true })
    }
    this.cleanupPending.delete(resourceKey(resource))
  }
  private async mediaReady(playback: Playback, inputUuid: string, durationMs: number, check: () => void) {
    const requestedAt = Date.now(), deadline = requestedAt + 2000
    let attempts = 0, lastState: Data = {}, firstCursor: number | undefined
    for (;;) {
      check()
      lastState = await this.client.call('GetMediaInputStatus', { inputUuid }); attempts++
      check()
      if (Number(lastState.mediaDuration) > durationMs) throw fail('DURATION_TOO_SHORT', 'The actual effect member duration exceeds its common playback window')
      const cursor = lastState.mediaCursor
      // Hidden ffmpeg RESTART can report PLAYING without starting its decoder.
      // Require a reset cursor followed by actual progression while masked.
      // Preparation is masked and rewound afterwards, so slow first-frame
      // scheduling may use up to 500ms without shortening the visible window.
      if (lastState.mediaState === 'OBS_MEDIA_STATE_PLAYING' && typeof lastState.mediaDuration === 'number' && lastState.mediaDuration > 0 && typeof cursor === 'number' && Number.isFinite(cursor) && cursor >= 0 && cursor <= 500) {
        if (firstCursor === undefined) { firstCursor = cursor; continue }
        if (cursor > firstCursor) return { inputUuid, at: Date.now(), requestedAt, attempts, mediaState: lastState.mediaState, mediaCursor: cursor, cursorProgressVerified: true }
      }
      if (Date.now() >= deadline) throw Object.assign(fail('MEDIA_START_FAILED', `Media restart did not confirm a reset playing cursor within two seconds (${lastState.mediaState}, cursor ${lastState.mediaCursor})`), { mediaState: lastState.mediaState, mediaCursor: lastState.mediaCursor })
      await new Promise<void>(resolve => {
        playback.wake = resolve
        playback.timer = setTimeout(resolve, Math.min(25, deadline - Date.now()))
        if (playback.controller.signal.aborted) resolve()
      })
      if (playback.timer) clearTimeout(playback.timer)
      playback.timer = undefined; playback.wake = undefined
    }
  }
  private async sourceShowing(playback: Playback, inputUuid: string, check: () => void) {
    const deadline = Date.now() + 2000
    for (;;) {
      check()
      const active = await this.client.call('GetSourceActive', { sourceUuid: inputUuid }); check()
      if (active.videoShowing === true) return
      if (Date.now() >= deadline) throw fail('MEDIA_START_FAILED', 'The masked OBS source did not become showing within two seconds')
      await new Promise<void>(resolve => { playback.wake = resolve; playback.timer = setTimeout(resolve, Math.min(25, deadline - Date.now())); if (playback.controller.signal.aborted) resolve() })
      if (playback.timer) clearTimeout(playback.timer)
      playback.timer = undefined; playback.wake = undefined
    }
  }
  private async rewindPaused(playback: Playback, inputUuid: string, check: () => void) {
    check(); await this.client.call('TriggerMediaInputAction', { inputUuid, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE' }); check()
    await this.client.call('SetMediaInputCursor', { inputUuid, mediaCursor: 0 }); check()
    const deadline = Date.now() + 2000
    for (;;) {
      check()
      const status = await this.client.call('GetMediaInputStatus', { inputUuid }); check()
      if (status.mediaState === 'OBS_MEDIA_STATE_PAUSED' && typeof status.mediaCursor === 'number' && status.mediaCursor >= 0 && status.mediaCursor <= 50) return
      if (Date.now() >= deadline) throw fail('MEDIA_START_FAILED', 'The decoder did not confirm a paused first frame within two seconds')
      await new Promise<void>(resolve => { playback.wake = resolve; playback.timer = setTimeout(resolve, Math.min(25, deadline - Date.now())); if (playback.controller.signal.aborted) resolve() })
      if (playback.timer) clearTimeout(playback.timer)
      playback.timer = undefined; playback.wake = undefined
    }
  }
  async play(job: EffectGroupJob, supplied: EffectGroupResource, signal: AbortSignal, onStarted: (detail?: Data) => void | Promise<void>) {
    if (this.stopping || this.cleanupPending.has(resourceKey(supplied))) throw fail('CLEANUP_FAILED', 'Group cleanup is unresolved or player is stopped')
    if (supplied.state !== 'ready' || job.accountId !== supplied.accountId || job.group.groupId !== supplied.groupId || job.generation !== undefined && job.generation !== supplied.generation)
      throw fail('RESOURCE_STALE', 'The queued playback resource generation is no longer ready')
    if (hash({ group: snapshot(job.group), targetSceneName: supplied.parentSceneName }) !== supplied.configHash) throw fail('RESOURCE_STALE', 'Playback cannot change its immutable group configuration')
    if (this.active.has(resourceKey(supplied))) throw fail('RESOURCE_BUSY', 'The private effect generation is already active')
    const resource = structuredClone(supplied), epoch = this.epoch
    const playback: Playback = { resource, token: randomUUID(), controller: new AbortController(), pendingChannels: new Set(this.nativeChannels(resource)), parentPending: true, maskPending: true }
    const check = () => { if (signal.aborted || playback.controller.signal.aborted || epoch !== this.epoch || this.stopping) throw fail('PLAYBACK_ABORTED', 'Effect playback was interrupted') }
    const abort = () => { playback.controller.abort(); playback.wake?.() }
    signal.addEventListener('abort', abort, { once: true })
    this.active.set(resourceKey(resource), playback)
    const work = (async () => {
      let failure: unknown
      try {
        check(); await this.options.connect(); check(); await this.validate(resource); check()
        resource.cleanupToken = playback.token; await this.persist(resource); check()
        await this.setMask(resource, true); check()
        await this.client.call('SetSceneItemEnabled', { sceneUuid: resource.parentSceneUuid, sceneItemId: resource.parentItemId, sceneItemEnabled: true }); check()
        const acknowledgements: Data[] = []
        for (const input of resource.animationInputs) {
          check()
          if (input.kind !== 'obs-media') continue
          const current = await this.client.call('GetInputSettings', { inputUuid: input.inputUuid })
          const file = (current.inputSettings as Data)?.local_file
          if (typeof file !== 'string' || !(await stat(file).catch(() => undefined))?.isFile()) throw fail('ASSET_UNAVAILABLE', 'An effect member file is unavailable')
          await this.sourceShowing(playback, input.inputUuid!, check)
          check(); await this.client.call('TriggerMediaInputAction', { inputUuid: input.inputUuid, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' }); check()
          acknowledgements.push(await this.mediaReady(playback, input.inputUuid!, job.group.durationMs, check))
          await this.rewindPaused(playback, input.inputUuid!, check)
        }
        const name = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(job.displayName.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim())].slice(0, 80).map(segment => segment.segment).join('')
        if (!name) throw fail('CAPTION_EMPTY', 'A real observed viewer display name is required')
        const text = job.group.caption.template.replaceAll('{{viewer.displayName}}', name)
        for (const channel of playback.pendingChannels) {
          check()
          const caption = channel.endsWith('/caption'), index = caption ? -1 : Number(channel.split('/').at(-1))
          await this.emit({ channel, kind: 'welcome', operation: 'show', token: playback.token, text: caption ? text : '', mode: 'wide', style: job.group.caption.style, holdMs: job.group.durationMs, group: true, actionKind: job.actionKind, role: caption ? 'caption' : 'animation', slot: job.group.slot, placement: caption ? 'lower-center' : job.group.animations[index].placement, ...(caption ? {} : { presetId: resource.animationInputs[index].assetId }) })
          acknowledgements.push({ channel, at: Date.now(), acknowledgement: 'obs-browser-transport' })
        }
        check()
        for (const input of resource.animationInputs) {
          if (input.kind !== 'obs-media') continue
          check(); await this.client.call('TriggerMediaInputAction', { inputUuid: input.inputUuid, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY' }); check()
        }
        await this.setMask(resource, false)
        check()
        const startedAt = Date.now()
        // RPC receipts prove command delivery only; actual decoder/renderer skew requires recording evidence.
        await onStarted({ generation: resource.generation, token: playback.token, startedAt, durationMs: job.group.durationMs, members: acknowledgements, evidence: 'rpc-acknowledgements', visualSyncVerified: false })
        check()
        await new Promise<void>(resolve => { playback.wake = resolve; playback.timer = setTimeout(resolve, Math.max(0, startedAt + job.group.durationMs - Date.now())); if (playback.controller.signal.aborted || signal.aborted) resolve() })
        check()
      } catch (error) { failure = error }
      try { await this.cleanup(playback) }
      catch (error) { if (failure) throw Object.assign(new AggregateError([failure, error], `Playback and group cleanup failed: ${message(failure)}; ${message(error)}`), { code: 'CLEANUP_FAILED', cleanupFailed: true }); throw error }
      finally { signal.removeEventListener('abort', abort); if (this.active.get(resourceKey(resource)) === playback) this.active.delete(resourceKey(resource)) }
      if (failure) throw failure
    })()
    playback.completion = work
    return work
  }
  async retire(supplied: EffectGroupResource) {
    const resource = structuredClone(supplied)
    const playback = this.active.get(resourceKey(resource))
    if (playback) playback.resource.state = 'retiring'
    resource.state = 'retiring'; await this.persist(resource)
    if (playback) await playback.completion
    // The active snapshot may have written its final ready state while retirement waited.
    resource.state = 'retiring'; await this.persist(resource)
    await this.options.connect()
    try {
      await this.validate(resource, true)
      const stopped: Playback = { resource, token: resource.cleanupToken || randomUUID(), controller: new AbortController(), pendingChannels: new Set(this.nativeChannels(resource)), parentPending: true, maskPending: true }
      await this.cleanup(stopped)
      const failures: unknown[] = []
      const parentIdentity = resource.ownedIdentities.find(identity => identity.kind === 'scene-item')!
      const parent = (await this.items({ sceneName: resource.parentSceneName, sceneUuid: resource.parentSceneUuid! })).find(item => item.sceneItemId === resource.parentItemId)
      if (parent) {
        try { await this.client.call('RemoveSceneItem', { sceneUuid: resource.parentSceneUuid, sceneItemId: resource.parentItemId }); parentIdentity.removed = true; await this.persist(resource) }
        catch (error) { const exists = (await this.items({ sceneName: resource.parentSceneName, sceneUuid: resource.parentSceneUuid! })).some(item => item.sceneItemId === resource.parentItemId); if (exists) failures.push(error); else { parentIdentity.removed = true; await this.persist(resource) } }
      } else { parentIdentity.removed = true; await this.persist(resource) }
      for (const identity of resource.ownedIdentities.filter(identity => identity.kind === 'input')) {
        try {
          await this.requireMarker(resource, identity)
          const inventory = await this.inventory()
          if (inventory.inputs.some(input => input.inputUuid === identity.uuid)) await this.client.call('RemoveInput', { inputUuid: identity.uuid })
          identity.removed = true; await this.persist(resource)
        } catch (error) {
          const inventory = await this.inventory()
          if (inventory.inputs.some(input => input.inputUuid === identity.uuid)) failures.push(error)
          else { identity.removed = true; await this.persist(resource) }
        }
      }
      const sceneIdentity = resource.ownedIdentities.find(identity => identity.kind === 'scene')!
      if (!failures.length) {
        try {
          await this.requireMarker(resource, sceneIdentity)
          if ((await this.inventory()).scenes.some(scene => scene.sceneUuid === resource.sceneUuid)) await this.client.call('RemoveScene', { sceneUuid: resource.sceneUuid })
          sceneIdentity.removed = true; await this.persist(resource)
        } catch (error) { if ((await this.inventory()).scenes.some(scene => scene.sceneUuid === resource.sceneUuid)) failures.push(error); else { sceneIdentity.removed = true; await this.persist(resource) } }
      }
      if (failures.length) throw new AggregateError(failures, `Group retirement failed: ${failures.map(message).join('; ')}`)
      this.resources.delete(resourceKey(resource))
      return { retired: true, resource }
    } catch (error) {
      resource.state = (error as { code?: string }).code === 'OWNERSHIP_CONFLICT' ? 'conflict' : 'retiring'
      resource.error = storedError(error); await this.persist(resource); throw error
    }
  }
  async recover(resources: EffectGroupResource[]) {
    await this.options.connect()
    const errors: unknown[] = []
    for (const supplied of resources) {
      const resource = structuredClone(supplied)
      this.resources.set(resourceKey(resource), resource)
      try {
        if (resource.state === 'retiring') { await this.retire(resource); continue }
        if (!resource.sceneUuid || resource.parentItemId === undefined) continue
        const playback: Playback = { resource, token: resource.cleanupToken || randomUUID(), controller: new AbortController(), pendingChannels: new Set(this.nativeChannels(resource)), parentPending: true, maskPending: true }
        await this.cleanup(playback)
      } catch (error) { errors.push(error) }
    }
    if (errors.length) throw Object.assign(new AggregateError(errors, `Effect group recovery failed: ${errors.map(message).join('; ')}`), { code: 'CLEANUP_FAILED', cleanupFailed: true })
  }
  stop() {
    if (this.stopWork) return this.stopWork
    this.stopping = true; this.epoch++
    const active = [...this.active.values()]
    for (const playback of active) { if (playback.timer) clearTimeout(playback.timer); playback.controller.abort(); playback.wake?.() }
    this.stopWork = (async () => {
      const errors: unknown[] = []
      // A control already sent to OBS must finish before stop can report completion.
      await Promise.allSettled([...this.controls.values()])
      const results = await Promise.allSettled(active.map(playback => playback.completion))
      for (const result of results) if (result.status === 'rejected' && (result.reason as { cleanupFailed?: boolean })?.cleanupFailed) errors.push(result.reason)
      const retained = [...this.cleanupPending.values()].filter(playback => !active.includes(playback))
      for (const playback of retained) { try { await this.cleanup(playback) } catch (error) { errors.push(error) } }
      if (errors.length) throw Object.assign(new AggregateError(errors, `Group cleanup failed during stop: ${errors.map(message).join('; ')}`), { code: 'CLEANUP_FAILED', cleanupFailed: true })
    })().finally(() => { this.stopWork = undefined })
    return this.stopWork
  }
}
