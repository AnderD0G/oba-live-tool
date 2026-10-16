import { OBS_WELCOME_PRESETS, type ObsWelcomePresetId } from './obsWelcome'

export const EFFECT_ACTION_KINDS = ['enter', 'follow', 'like', 'gift'] as const
export const EFFECT_SLOTS = ['main-stage', 'corner-left', 'corner-right'] as const
export const EFFECT_PLACEMENTS = ['border', 'lower-edge', 'lower-center', 'center', 'corner-left', 'corner-right', 'full-screen'] as const
export type EffectActionKind = (typeof EFFECT_ACTION_KINDS)[number]
export type EffectSlot = (typeof EFFECT_SLOTS)[number]
export type EffectPlacement = (typeof EFFECT_PLACEMENTS)[number]
export interface EffectGroupSpec {
  groupId: string
  audienceRuleId: string
  actionKind: EffectActionKind
  enabled: boolean
  slot: EffectSlot
  concurrency: 'auto' | 'parallel' | 'serialize'
  priority: number
  durationMs: number
  animations: { assetId: ObsWelcomePresetId; placement: EffectPlacement; shortAssetEnd: 'hold-last-frame' }[]
  caption: { template: string; style: 'brief' | 'rainbow' }
  coalesce: 'same-user-group-latest' | 'none'
}
export interface EffectGroupSchedulerConfig {
  queueCapacity: number
  perSlotCapacity: number
  eventOrder: EffectActionKind[]
  ttlMs: Record<EffectActionKind, number>
  preemptActive: false
}
export interface EffectGroupsConfig {
  schemaVersion: 1
  revision: number
  accountId: string
  enabled: boolean
  targetSceneName: string
  scheduler: EffectGroupSchedulerConfig
  groups: EffectGroupSpec[]
}
export type EffectGroupChanges = Partial<Omit<EffectGroupSpec, 'groupId' | 'audienceRuleId' | 'actionKind'>>
export interface EffectGroupsPatch {
  enabled?: boolean
  targetSceneName?: string
  scheduler?: Partial<Omit<EffectGroupSchedulerConfig, 'ttlMs'>> & { ttlMs?: Partial<Record<EffectActionKind, number>> }
  operations?: ({ op: 'upsert'; group: Omit<EffectGroupSpec, 'groupId'> & { groupId?: string } }
    | { op: 'update'; groupId: string; changes: EffectGroupChanges }
    | { op: 'delete'; groupId: string })[]
}
export interface EffectAsset {
  id: ObsWelcomePresetId
  label: string
  kind: 'html' | 'obs-media'
  durationMs: number
  available: boolean
  reason?: string
  sourceName?: string
  sourceUuid?: string
  sourceContainerName?: string
  sourceContainerUuid?: string
  inputKind?: string
  settingsHash?: string
  conflictSlots?: EffectSlot[]
}
export interface EffectOwnedIdentity {
  kind: 'scene' | 'input' | 'scene-item' | 'filter'
  name?: string
  uuid?: string
  parentUuid?: string
  itemId?: number
  settingsHash?: string
  intentId?: string
  markerKey?: string
  created?: boolean
  removed?: boolean
  transformHash?: string
}
export interface EffectGroupResource {
  accountId: string
  groupId: string
  generation: number
  installId: string
  sceneName: string
  sceneUuid?: string
  parentSceneName: string
  parentSceneUuid?: string
  parentItemId?: number
  captionInputName: string
  captionInputUuid?: string
  animationInputs: { assetId: ObsWelcomePresetId; inputName: string; inputUuid?: string; kind: 'html' | 'obs-media'; settingsHash?: string; intentId?: string; created?: boolean }[]
  state: 'ready' | 'pending' | 'conflict' | 'retiring' | 'failed'
  configHash: string
  label: string
  ownedIdentities: EffectOwnedIdentity[]
  creationNonce?: string
  captionSettingsHash?: string
  sourceRevision?: string
  error?: string
  cleanupToken?: string
  snapshot?: EffectGroupSpec
}
export interface EffectGroupJob {
  runId: string
  accountId: string
  eventId: string
  actionKind: EffectActionKind
  userId: string
  displayName: string
  receivedAt: number
  sequence: number
  configRevision: number
  group: EffectGroupSpec
  requiredSlots?: EffectSlot[]
  generation?: number
  resource?: EffectGroupResource
  audienceRevision?: number
  matchedRuleId?: string
  facts?: Record<string, unknown>
  preview?: boolean
}
export interface EffectGroupRunEvent {
  runId: string
  accountId: string
  groupId: string
  eventId: string
  at: number
  status: 'queued' | 'preparing' | 'started' | 'completed' | 'failed' | 'skipped' | 'interrupted'
  reason?: string
  detail?: Record<string, unknown>
}
export interface EffectGroupCommand {
  action: 'get' | 'catalog' | 'simulate' | 'apply' | 'sync' | 'status' | 'preview'
  params: Record<string, unknown> & { accountId: string }
}
export interface EffectGroupProofBinding {
  configHash: string
  expectedRevision: number
  audienceRevision: number
  catalogRevision: string
  targetSceneName: string
}
export interface EffectGroupProof extends EffectGroupProofBinding {
  token: string
  accountId: string
  expiresAt: number
}

export class EffectGroupError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'EffectGroupError' }
}
export function effectGroupObject(input: unknown, fields: readonly string[], name: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new EffectGroupError('INVALID_EFFECT_GROUP', `${name} must be an object`)
  }
  const value = input as Record<string, unknown>
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) throw new EffectGroupError('INVALID_EFFECT_GROUP', `${name}.${key} is not allowed`)
    if (value[key] === null) throw new EffectGroupError('INVALID_EFFECT_GROUP', `${name}.${key} cannot be null`)
  }
  return value
}
export function effectGroupString(input: unknown, name: string, max = 128, empty = false): string {
  if (typeof input !== 'string' || input.length > max || (!empty && !input.length) || /[\u0000-\u001f\u007f]/.test(input) || input.trim() !== input) {
    throw new EffectGroupError('INVALID_EFFECT_GROUP', `${name} must be a bounded string`)
  }
  return input
}
export function effectGroupInteger(input: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) throw new EffectGroupError('INVALID_EFFECT_GROUP', `${name} is out of bounds`)
  return input
}
function enumValue<T extends string>(input: unknown, allowed: readonly T[], name: string): T {
  if (typeof input !== 'string' || !allowed.includes(input as T)) throw new EffectGroupError('INVALID_EFFECT_GROUP', `${name} is unsupported`)
  return input as T
}
function booleanValue(input: unknown, name: string): boolean {
  if (typeof input !== 'boolean') throw new EffectGroupError('INVALID_EFFECT_GROUP', `${name} must be boolean`)
  return input
}

// Synchronous SHA-1 for RFC 9562 UUIDv5; shared code also runs in the renderer.
function sha1(input: Uint8Array): Uint8Array {
  const data = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64)
  data.set(input); data[input.length] = 0x80
  const view = new DataView(data.buffer)
  view.setUint32(data.length - 4, input.length * 8)
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0
  const rotate = (x: number, n: number) => (x << n) | (x >>> (32 - n))
  const words = new Uint32Array(80)
  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 80; i++) words[i] = rotate(words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16], 1)
    let a = h0, b = h1, c = h2, d = h3, e = h4
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6
      const next = (rotate(a, 5) + f + e + k + words[i]) >>> 0
      e = d; d = c; c = rotate(b, 30); b = a; a = next
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0
  }
  const result = new Uint8Array(20), output = new DataView(result.buffer)
  for (const [i, value] of [h0, h1, h2, h3, h4].entries()) output.setUint32(i * 4, value)
  return result
}
export const EFFECT_GROUP_NAMESPACE = 'a0a59c7a-c380-5bf0-8319-f3556f7713d9'
export function effectGroupId(accountId: string, audienceRuleId: string, actionKind: EffectActionKind): string {
  effectGroupString(accountId, 'accountId'); effectGroupString(audienceRuleId, 'audienceRuleId')
  enumValue(actionKind, EFFECT_ACTION_KINDS, 'actionKind')
  const namespace = Uint8Array.from(EFFECT_GROUP_NAMESPACE.replace(/-/g, '').match(/../g)!.map(value => Number.parseInt(value, 16)))
  const name = new TextEncoder().encode(JSON.stringify([accountId, audienceRuleId, actionKind]))
  const input = new Uint8Array(namespace.length + name.length); input.set(namespace); input.set(name, 16)
  const hash = sha1(input).slice(0, 16); hash[6] = (hash[6] & 0x0f) | 0x50; hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
const GROUP_FIELDS = ['groupId', 'audienceRuleId', 'actionKind', 'enabled', 'slot', 'concurrency', 'priority', 'durationMs', 'animations', 'caption', 'coalesce']
export function normalizeEffectGroup(input: unknown, accountId: string): EffectGroupSpec {
  const value = effectGroupObject(input, GROUP_FIELDS, 'group')
  const audienceRuleId = effectGroupString(value.audienceRuleId, 'audienceRuleId')
  const actionKind = enumValue(value.actionKind, EFFECT_ACTION_KINDS, 'actionKind')
  const groupId = effectGroupId(accountId, audienceRuleId, actionKind)
  if (value.groupId !== undefined && value.groupId !== groupId) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'groupId does not match logical identity')
  if (!Array.isArray(value.animations) || value.animations.length < 1 || value.animations.length > 3) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'animations requires 1–3 assets')
  const animations = value.animations.map(item => {
    const animation = effectGroupObject(item, ['assetId', 'placement', 'shortAssetEnd'], 'animation')
    return { assetId: enumValue(animation.assetId, OBS_WELCOME_PRESETS.map(asset => asset.id), 'assetId'),
      placement: enumValue(animation.placement, EFFECT_PLACEMENTS, 'placement'),
      shortAssetEnd: enumValue(animation.shortAssetEnd ?? 'hold-last-frame', ['hold-last-frame'], 'shortAssetEnd') }
  })
  if (new Set(animations.map(item => item.assetId)).size !== animations.length) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'Duplicate animation asset')
  const durationMs = effectGroupInteger(value.durationMs ?? 4000, 'durationMs', 1000, 10000)
  if (animations.some(item => OBS_WELCOME_PRESETS.find(asset => asset.id === item.assetId)!.durationMs > durationMs)) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'durationMs truncates a complete asset')
  const caption = effectGroupObject(value.caption ?? { template: '{{viewer.displayName}}', style: 'brief' }, ['template', 'style'], 'caption')
  const template = effectGroupString(caption.template, 'caption.template', 512)
  if (/[<>]/.test(template) || /\{\{(?!viewer\.displayName\}\})/.test(template)) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'caption.template contains unsupported markup or interpolation')
  return { groupId, audienceRuleId, actionKind, enabled: booleanValue(value.enabled ?? true, 'enabled'),
    slot: enumValue(value.slot ?? 'main-stage', EFFECT_SLOTS, 'slot'),
    concurrency: enumValue(value.concurrency ?? 'auto', ['auto', 'parallel', 'serialize'], 'concurrency'),
    priority: effectGroupInteger(value.priority ?? 0, 'priority', -1000, 1000), durationMs, animations,
    caption: { template, style: enumValue(caption.style ?? 'brief', ['brief', 'rainbow'], 'caption.style') },
    coalesce: enumValue(value.coalesce ?? 'same-user-group-latest', ['same-user-group-latest', 'none'], 'coalesce') }
}
function normalizeScheduler(input: unknown): EffectGroupSchedulerConfig {
  const value = effectGroupObject(input ?? {}, ['queueCapacity', 'perSlotCapacity', 'eventOrder', 'ttlMs', 'preemptActive'], 'scheduler')
  if (value.preemptActive !== undefined && value.preemptActive !== false) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'preemptActive must be false')
  const ttl = effectGroupObject(value.ttlMs ?? {}, [...EFFECT_ACTION_KINDS], 'ttlMs')
  const eventOrder = value.eventOrder ?? ['gift', 'enter', 'follow', 'like']
  if (!Array.isArray(eventOrder) || eventOrder.length !== 4 || new Set(eventOrder).size !== 4) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'eventOrder must include all four actions once')
  const queueCapacity = effectGroupInteger(value.queueCapacity ?? 32, 'queueCapacity', 1, 32)
  const perSlotCapacity = effectGroupInteger(value.perSlotCapacity ?? Math.min(16, queueCapacity), 'perSlotCapacity', 1, Math.min(16, queueCapacity))
  return { queueCapacity, perSlotCapacity, eventOrder: eventOrder.map(kind => enumValue(kind, EFFECT_ACTION_KINDS, 'eventOrder')),
    ttlMs: { gift: effectGroupInteger(ttl.gift ?? 30000, 'ttlMs.gift', 1, 120000),
      enter: effectGroupInteger(ttl.enter ?? 8000, 'ttlMs.enter', 1, 120000),
      follow: effectGroupInteger(ttl.follow ?? 8000, 'ttlMs.follow', 1, 120000),
      like: effectGroupInteger(ttl.like ?? 3000, 'ttlMs.like', 1, 120000) }, preemptActive: false }
}
export function normalizeEffectGroupsConfig(input: unknown, accountId: string): EffectGroupsConfig {
  effectGroupString(accountId, 'accountId')
  const value = effectGroupObject(input === undefined ? {} : input, ['schemaVersion', 'revision', 'accountId', 'enabled', 'targetSceneName', 'scheduler', 'groups'], 'config')
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'Unsupported schemaVersion')
  if (value.accountId !== undefined && value.accountId !== accountId) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'accountId mismatch')
  const enabled = booleanValue(value.enabled ?? false, 'enabled')
  const targetSceneName = effectGroupString(value.targetSceneName ?? '', 'targetSceneName', 256, !enabled)
  if (!Array.isArray(value.groups ?? []) || (value.groups as unknown[] | undefined)?.length! > 80) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'groups exceeds 80')
  const groups = ((value.groups ?? []) as unknown[]).map(group => normalizeEffectGroup(group, accountId))
  if (new Set(groups.map(group => group.groupId)).size !== groups.length) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'Duplicate logical group')
  return { schemaVersion: 1, revision: effectGroupInteger(value.revision ?? 0, 'revision'), accountId, enabled,
    targetSceneName, scheduler: normalizeScheduler(value.scheduler), groups }
}
export function applyEffectGroupsPatch(config: EffectGroupsConfig, input: EffectGroupsPatch | unknown): EffectGroupsConfig {
  const value = effectGroupObject(input, ['enabled', 'targetSceneName', 'scheduler', 'operations'], 'patch')
  const next = structuredClone(normalizeEffectGroupsConfig(config, config.accountId))
  if (value.enabled !== undefined) next.enabled = booleanValue(value.enabled, 'enabled')
  if (value.targetSceneName !== undefined) next.targetSceneName = effectGroupString(value.targetSceneName, 'targetSceneName', 256)
  if (value.scheduler !== undefined) {
    const scheduler = effectGroupObject(value.scheduler, ['queueCapacity', 'perSlotCapacity', 'eventOrder', 'ttlMs', 'preemptActive'], 'scheduler')
    next.scheduler = normalizeScheduler({ ...next.scheduler, ...scheduler, ttlMs: { ...next.scheduler.ttlMs, ...(scheduler.ttlMs as object | undefined) } })
  }
  if (!Array.isArray(value.operations ?? []) || (value.operations as unknown[] | undefined)?.length! > 100) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'operations exceeds 100')
  for (const raw of (value.operations ?? []) as unknown[]) {
    const operation = effectGroupObject(raw, ['op', 'groupId', 'changes', 'group'], 'operation')
    if (operation.op === 'upsert') {
      effectGroupObject(raw, ['op', 'group'], 'upsert')
      const group = normalizeEffectGroup(operation.group, next.accountId)
      const index = next.groups.findIndex(existing => existing.groupId === group.groupId)
      if (index === -1) next.groups.push(group); else next.groups[index] = group
    } else if (operation.op === 'update' || operation.op === 'delete') {
      effectGroupObject(raw, operation.op === 'update' ? ['op', 'groupId', 'changes'] : ['op', 'groupId'], operation.op)
      const index = next.groups.findIndex(group => group.groupId === operation.groupId)
      if (index === -1) throw new EffectGroupError('EFFECT_GROUP_NOT_FOUND', 'Group not found')
      if (operation.op === 'delete') next.groups.splice(index, 1)
      else {
        const changes = effectGroupObject(operation.changes, GROUP_FIELDS.filter(field => !['groupId', 'audienceRuleId', 'actionKind'].includes(field)), 'changes')
        next.groups[index] = normalizeEffectGroup({ ...next.groups[index], ...changes }, next.accountId)
      }
    } else throw new EffectGroupError('INVALID_EFFECT_GROUP', 'Unsupported patch operation')
  }
  return normalizeEffectGroupsConfig(next, next.accountId)
}
export function canonicalEffectGroupJson(value: unknown): string {
  const visit = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(visit)
    if (input && typeof input === 'object') return Object.fromEntries(Object.keys(input).sort().filter(key => (input as Record<string, unknown>)[key] !== undefined).map(key => [key, visit((input as Record<string, unknown>)[key])]))
    return input
  }
  return JSON.stringify(visit(value))
}
