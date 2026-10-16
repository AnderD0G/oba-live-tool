import {
  type DirectorConfig,
  type DirectorProduct,
  type DirectorStep,
  type DirectorTray,
  directorStepAudioFiles,
  isDirectorVideoStep,
  newDirectorStep,
} from './director'

/**
 * 互动导播配置的结构化编辑操作。
 *
 * 为什么不是「整份配置覆盖」：配置里有几十个嵌套字段和大量绝对路径，
 * 让 AI 或脚本每次重写整份文档，既容易丢字段也容易写坏别人的托盘。
 * 这里只接受一组精确操作，逐条落到副本上，再由 validateDirectorConfig 兜底。
 */

export type DirectorStepMode = 'A' | 'B' | 'C'

export interface DirectorStepPath {
  /** 托盘 id 或托盘名称 */
  trayId: string
  /** A 总览步骤不需要；B/C 步骤必填 */
  productId?: string
  mode: DirectorStepMode
}

/** 可编辑的字段；id、trays、products、A/B/C 由各自的操作用于管理 */
export type DirectorConfigPatch = Partial<
  Pick<
    DirectorConfig,
    | 'scene'
    | 'ffmpeg'
    | 'ffprobe'
    | 'canvasWidth'
    | 'canvasHeight'
    | 'transitionMs'
    | 'transition'
    | 'normalSeconds'
    | 'requestSeconds'
    | 'interruptAOnRequest'
    | 'queueSkipsOverview'
    | 'maxQueue'
    | 'cooldownSeconds'
    | 'popup'
    | 'listen'
    | 'aiPolicy'
    | 'interaction'
  >
>

export type DirectorTrayInput = Partial<Omit<DirectorTray, 'products' | 'A'>> & { id?: string }
export type DirectorProductInput = Partial<Omit<DirectorProduct, 'B' | 'C'>> & { id?: string }
export type DirectorStepInput = Partial<DirectorStep> & { id?: string }

export type DirectorOp =
  | { op: 'setConfig'; patch: DirectorConfigPatch }
  | { op: 'upsertTray'; tray: DirectorTrayInput }
  | { op: 'deleteTray'; trayId: string }
  | { op: 'upsertProduct'; trayId: string; product: DirectorProductInput }
  | { op: 'deleteProduct'; trayId: string; productId: string }
  | { op: 'upsertStep'; path: DirectorStepPath; step: DirectorStepInput }
  | { op: 'deleteStep'; path: DirectorStepPath; stepId: string }
  | { op: 'moveStep'; path: DirectorStepPath; stepId: string; toIndex: number }

export interface DirectorOpsResult {
  config: DirectorConfig
  /** 每条操作做了什么，便于调用方和用户逐条核对 */
  applied: string[]
}

const MAX_OPS = 200
const MAX_TEXT = 20000

const CONFIG_FIELDS = {
  scene: 'string',
  ffmpeg: 'string',
  ffprobe: 'string',
  canvasWidth: 'number',
  canvasHeight: 'number',
  transitionMs: 'number',
  transition: 'any',
  normalSeconds: 'number',
  requestSeconds: 'number',
  interruptAOnRequest: 'boolean',
  queueSkipsOverview: 'boolean',
  maxQueue: 'number',
  cooldownSeconds: 'number',
  popup: 'boolean',
  listen: 'boolean',
  aiPolicy: 'string',
  interaction: 'any',
} as const

const TRAY_FIELDS = {
  id: 'string',
  name: 'string',
  summary: 'string',
  stateGroup: 'string',
  transitionIn: 'string',
  transitionOut: 'string',
} as const

const PRODUCT_FIELDS = {
  id: 'string',
  name: 'string',
  aliases: 'string[]',
  goodsId: 'number-or-null',
  stateGroups: 'any',
  facts: 'string',
  notes: 'any',
  /** { in?, out? }：本商品的进入/回到总览转场覆盖 */
  transition: 'any',
} as const

const STEP_FIELDS = {
  id: 'string',
  name: 'string',
  kind: 'string',
  file: 'string',
  start: 'number',
  end: 'number',
  audio: 'string[]',
  audioOverflow: 'string',
  speechSlot: 'boolean',
  speechWindows: 'any',
  cues: 'any',
  goodsId: 'number-or-null',
  overlayGroup: 'string',
  overlayVariants: 'any',
  stepGroup: 'string',
  duration: 'number',
  caption: 'string',
  optional: 'boolean',
} as const

type FieldSpec = Record<
  string,
  'string' | 'number' | 'boolean' | 'string[]' | 'number-or-null' | 'any'
>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只做结构检查：未知字段和明显错误的类型直接拒绝，深度规则交给 validateDirectorConfig */
function checkFields(input: unknown, spec: FieldSpec, label: string) {
  if (!isPlainObject(input)) throw new Error(`${label}必须是一个对象`)
  for (const [key, value] of Object.entries(input)) {
    const expected = spec[key]
    if (!expected) throw new Error(`${label}出现未知字段「${key}」`)
    if (value === undefined) continue
    switch (expected) {
      case 'string':
        if (typeof value !== 'string') throw new Error(`${label}的「${key}」必须是字符串`)
        if (value.length > MAX_TEXT) throw new Error(`${label}的「${key}」过长`)
        break
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value))
          throw new Error(`${label}的「${key}」必须是数字`)
        break
      case 'boolean':
        if (typeof value !== 'boolean') throw new Error(`${label}的「${key}」必须是 true 或 false`)
        break
      case 'number-or-null':
        if (value !== null && (typeof value !== 'number' || !Number.isFinite(value)))
          throw new Error(`${label}的「${key}」必须是数字或 null`)
        break
      case 'string[]':
        if (!Array.isArray(value) || value.some(item => typeof item !== 'string'))
          throw new Error(`${label}的「${key}」必须是字符串数组`)
        break
      default:
        break
    }
  }
}

function requireText(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`)
  return value
}

/** 托盘既可以用 id 也可以用名称定位，方便按人话配置 */
function resolveTray(config: DirectorConfig, key: string): DirectorTray {
  const wanted = requireText(key, '托盘')
  const byId = config.trays.find(tray => tray.id === wanted)
  if (byId) return byId
  const byName = config.trays.filter(tray => tray.name === wanted)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) throw new Error(`有多个托盘都叫「${wanted}」，请改用托盘 id`)
  throw new Error(`找不到托盘「${wanted}」`)
}

function resolveProduct(tray: DirectorTray, productId: string): DirectorProduct {
  const wanted = requireText(productId, '商品编号')
  const product = tray.products.find(item => item.id === wanted)
  if (!product) throw new Error(`托盘「${tray.name}」里找不到商品「${wanted}」`)
  return product
}

/** A 是托盘总览；B/C 必须落在某个商品上 */
function resolveStepList(
  config: DirectorConfig,
  path: DirectorStepPath,
): { tray: DirectorTray; steps: DirectorStep[]; label: string } {
  if (!isPlainObject(path)) throw new Error('步骤位置必须是一个对象')
  const tray = resolveTray(config, path.trayId)
  if (path.mode === 'A') return { tray, steps: tray.A, label: `托盘「${tray.name}」A 总览` }
  if (path.mode !== 'B' && path.mode !== 'C') throw new Error('步骤位置 mode 只能是 A、B 或 C')
  const product = resolveProduct(tray, requireText(path.productId, 'B/C 步骤的商品编号'))
  return {
    tray,
    steps: product[path.mode],
    label: `商品「${product.id} ${product.name}」${path.mode}`,
  }
}

function mergeInto<T extends object>(target: T, patch: Record<string, unknown>): T {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    ;(target as Record<string, unknown>)[key] = value
  }
  return target
}

function newTray(id: string): DirectorTray {
  return {
    id,
    name: '新托盘',
    summary: '',
    A: [],
    transitionIn: '',
    transitionOut: '',
    products: [],
  }
}

function newProduct(id: string): DirectorProduct {
  return {
    id,
    name: '新商品',
    aliases: [],
    goodsId: null,
    stateGroups: {},
    facts: '',
    notes: {},
    B: [],
    C: [],
  }
}

/**
 * 把一组操作应用到配置副本上。不修改入参，出错时抛异常且不做任何写入。
 */
export function applyDirectorOps(
  source: DirectorConfig,
  ops: DirectorOp[],
  generateId: () => string = () => crypto.randomUUID(),
): DirectorOpsResult {
  if (!Array.isArray(ops)) throw new Error('ops 必须是数组')
  if (ops.length === 0) throw new Error('没有需要执行的操作')
  if (ops.length > MAX_OPS) throw new Error(`一次最多执行 ${MAX_OPS} 条操作`)

  const config = structuredClone(source)
  const applied: string[] = []

  for (const [index, op] of ops.entries()) {
    const at = `第 ${index + 1} 条操作`
    if (!isPlainObject(op)) throw new Error(`${at}必须是对象`)
    switch (op.op) {
      case 'setConfig': {
        checkFields(op.patch, CONFIG_FIELDS, `${at} setConfig`)
        mergeInto(config, op.patch as Record<string, unknown>)
        applied.push(`修改全局设置：${Object.keys(op.patch).join('、')}`)
        break
      }
      case 'upsertTray': {
        checkFields(op.tray, TRAY_FIELDS, `${at} upsertTray`)
        const input = op.tray
        let tray: DirectorTray | undefined
        if (input.id) tray = config.trays.find(item => item.id === input.id)
        else if (input.name) {
          const byName = config.trays.filter(item => item.name === input.name)
          if (byName.length > 1)
            throw new Error(`有多个托盘都叫「${input.name}」，请改用托盘 id 更新`)
          tray = byName[0]
        }
        if (!tray) {
          tray = newTray(input.id || generateId())
          config.trays.push(tray)
          mergeInto(tray, input as Record<string, unknown>)
          applied.push(`新建托盘「${tray.name}」`)
          break
        }
        mergeInto(tray, input as Record<string, unknown>)
        applied.push(`更新托盘「${tray.name}」`)
        break
      }
      case 'deleteTray': {
        const tray = resolveTray(config, op.trayId)
        config.trays = config.trays.filter(item => item.id !== tray.id)
        applied.push(`删除托盘「${tray.name}」`)
        break
      }
      case 'upsertProduct': {
        checkFields(op.product, PRODUCT_FIELDS, `${at} upsertProduct`)
        const tray = resolveTray(config, op.trayId)
        const input = op.product
        if (!input.id) throw new Error(`${at}新建商品必须给出观众使用的商品编号 id`)
        const product = tray.products.find(item => item.id === input.id)
        if (!product) {
          const created = newProduct(input.id)
          tray.products.push(created)
          mergeInto(created, input as Record<string, unknown>)
          applied.push(`在托盘「${tray.name}」新建商品「${created.id} ${created.name}」`)
          break
        }
        mergeInto(product, input as Record<string, unknown>)
        applied.push(`更新托盘「${tray.name}」的商品「${product.id} ${product.name}」`)
        break
      }
      case 'deleteProduct': {
        const tray = resolveTray(config, op.trayId)
        const product = resolveProduct(tray, op.productId)
        tray.products = tray.products.filter(item => item.id !== product.id)
        applied.push(`删除托盘「${tray.name}」的商品「${product.id} ${product.name}」`)
        break
      }
      case 'upsertStep': {
        checkFields(op.step, STEP_FIELDS, `${at} upsertStep`)
        const { steps, label } = resolveStepList(config, op.path)
        const input = op.step
        const existing = input.id ? steps.find(step => step.id === input.id) : undefined
        if (!existing) {
          const created = mergeInto(newDirectorStep(), input as Record<string, unknown>)
          if (!input.id) created.id = generateId()
          steps.push(created)
          applied.push(`在${label}新增步骤「${created.name}」`)
          break
        }
        mergeInto(existing, input as Record<string, unknown>)
        applied.push(`更新${label}的步骤「${existing.name}」`)
        break
      }
      case 'deleteStep': {
        const { steps, label } = resolveStepList(config, op.path)
        const stepId = requireText(op.stepId, '步骤 id')
        const index = steps.findIndex(step => step.id === stepId)
        if (index < 0) throw new Error(`${label}里找不到步骤「${stepId}」`)
        const name = steps[index].name
        steps.splice(index, 1)
        applied.push(`删除${label}的步骤「${name}」`)
        break
      }
      case 'moveStep': {
        const { steps, label } = resolveStepList(config, op.path)
        const stepId = requireText(op.stepId, '步骤 id')
        const from = steps.findIndex(step => step.id === stepId)
        if (from < 0) throw new Error(`${label}里找不到步骤「${stepId}」`)
        if (!Number.isInteger(op.toIndex) || op.toIndex < 0 || op.toIndex >= steps.length)
          throw new Error(`目标位置需要是 0 到 ${steps.length - 1} 之间的整数`)
        const [moved] = steps.splice(from, 1)
        steps.splice(op.toIndex, 0, moved)
        applied.push(`把${label}的步骤「${moved.name}」移到第 ${op.toIndex + 1} 位`)
        break
      }
      default: {
        const unknown = (op as { op?: unknown }).op
        throw new Error(`${at}的操作类型「${String(unknown)}」不支持`)
      }
    }
  }

  return { config, applied }
}

/** OBS 素材组等长文本在摘要里截断，避免把整份配置塞进上下文 */
function brief(value: string | undefined, max = 40) {
  if (!value) return ''
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function fileBrief(file: string | undefined) {
  if (!file) return ''
  const parts = file.split(/[\\/]/)
  return parts.at(-1) || file
}

function stepBrief(step: DirectorStep) {
  const cues = (step.cues || []).length
  return {
    id: step.id,
    name: step.name,
    kind: step.kind,
    file: fileBrief(step.file),
    start: step.start,
    end: step.end,
    audioCount: directorStepAudioFiles(step).length,
    audioOverflow: step.audioOverflow,
    ...(cues ? { cues } : {}),
    ...(step.overlayGroup ? { overlayGroup: brief(step.overlayGroup) } : {}),
    ...(step.overlayVariants?.length ? { overlayVariants: step.overlayVariants.length } : {}),
    ...(step.stepGroup ? { stepGroup: brief(step.stepGroup) } : {}),
    ...(isDirectorVideoStep(step) ? {} : { duration: step.duration }),
    ...(step.optional ? { optional: true } : {}),
    ...(step.caption ? { caption: brief(step.caption, 60) } : {}),
  }
}

/**
 * 给 AI 或脚本看的紧凑摘要：保留 id、名称、素材文件名与切点，
 * 省略绝对路径和长文本，避免一次读取就吃掉整个上下文。
 */
export function summarizeDirectorConfig(config: DirectorConfig) {
  return {
    version: config.version,
    scene: config.scene,
    canvas: `${config.canvasWidth}x${config.canvasHeight}`,
    transitionMs: config.transitionMs,
    transition: config.transition,
    normalSeconds: config.normalSeconds,
    requestSeconds: config.requestSeconds,
    interruptAOnRequest: config.interruptAOnRequest,
    queueSkipsOverview: config.queueSkipsOverview ?? true,
    maxQueue: config.maxQueue,
    cooldownSeconds: config.cooldownSeconds,
    popup: config.popup,
    listen: config.listen,
    interaction: config.interaction,
    aiPolicyLength: config.aiPolicy?.length ?? 0,
    trays: config.trays.map(tray => ({
      id: tray.id,
      name: tray.name,
      summary: brief(tray.summary, 80),
      stateGroup: brief(tray.stateGroup),
      transitionIn: fileBrief(tray.transitionIn),
      transitionOut: fileBrief(tray.transitionOut),
      A: tray.A.map(stepBrief),
      products: tray.products.map(product => ({
        id: product.id,
        name: product.name,
        aliases: product.aliases,
        goodsId: product.goodsId,
        stateGroups: product.stateGroups,
        factsLength: product.facts?.length ?? 0,
        notes: product.notes,
        B: product.B.map(stepBrief),
        C: product.C.map(stepBrief),
      })),
    })),
  }
}
