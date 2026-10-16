import type { DirectorConfig, DirectorProduct, DirectorStep, DirectorTray } from './director'
import { DEFAULT_CANCEL_KEYWORDS, DEFAULT_MODE_KEYWORDS } from './director'
import { DEFAULT_VIEWER_SCORE, VIEWER_SCORE_LABELS, VIEWER_SCORE_ORDER } from './viewerScore'

/**
 * 配置差异的「人话」描述。
 *
 * 这里刻意**不做**通用深比较 —— 那样输出的是
 * `trays[0].products[2].C[3].end` 这种代码路径，改配置的人看不懂。
 * 所有描述都按业务说话：托盘名、商品编号+名字、B/C 段、步骤名。
 *
 * 基准永远是**上一次保存的版本**：连改十次没保存，比的还是那同一个老版本。
 */
export interface DirectorChange {
  /** 作用域：全局 / 托盘「三角抓夹」/ 托盘「三角抓夹」· 商品 003 米黄 */
  scope: string
  /** 改了什么：AI 总纲 / C 段步骤「弹簧夹」 */
  field: string
  kind: 'added' | 'removed' | 'changed'
  /** 一行摘要 */
  summary: string
  /** 长文本的逐行变化（`- 旧` / `+ 新`），最多几条 */
  lines?: string[]
}

/** 长文本逐行对比最多列几条，多了折成一句"还有 N 处"。 */
const MAX_TEXT_LINES = 6

const yn = (value: unknown) => (value ? '开' : '关')
const show = (value: unknown) => {
  if (value === null || value === undefined) return '（空）'
  if (typeof value === 'boolean') return yn(value)
  const text = String(value)
  return text === '' ? '（空）' : text
}
const list = (value: string[] | undefined) => (value || []).join('、')
const lines = (value: string | undefined) => (value || '').split('\n').map(line => line.trimEnd())

/**
 * 最简单的行级差异：先掐掉首尾相同的行，中间整块算改动。
 * 资料卡这种一行一条的文本，这样看已经足够清楚，也比 LCS 好懂。
 */
export function changedLines(before: string, after: string): string[] {
  const a = lines(before)
  const b = lines(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++
  const removed = a.slice(head, a.length - tail)
  const added = b.slice(head, b.length - tail)
  const result = [
    ...removed.map(line => `- ${line || '（空行）'}`),
    ...added.map(line => `+ ${line || '（空行）'}`),
  ]
  if (result.length > MAX_TEXT_LINES)
    return [...result.slice(0, MAX_TEXT_LINES), `…还有 ${result.length - MAX_TEXT_LINES} 行变化`]
  return result
}

class Builder {
  changes: DirectorChange[] = []
  push(change: DirectorChange) {
    this.changes.push(change)
  }
  /** 单值对比：不一样才记一条。 */
  scalar(
    scope: string,
    field: string,
    label: string,
    before: unknown,
    after: unknown,
    format: (value: unknown) => string = show,
  ) {
    if (before === after) return
    this.push({
      scope,
      field,
      kind: 'changed',
      summary: `${label}：${format(before)} → ${format(after)}`,
    })
  }
  /** 多行文本对比：只报改了哪几行，不整段贴出来。 */
  textArea(scope: string, field: string, label: string, before: string, after: string) {
    if ((before || '') === (after || '')) return
    const detail = changedLines(before, after)
    const from = (before || '').length
    const to = (after || '').length
    const delta = to - from
    this.push({
      scope,
      field,
      kind: 'changed',
      summary: `${label}：${from} → ${to} 字（${delta >= 0 ? '+' : ''}${delta}）`,
      lines: detail,
    })
  }
  /** 词表对比：报出加了哪些、去了哪些。 */
  wordList(scope: string, field: string, label: string, before: string[], after: string[]) {
    const gone = before.filter(word => !after.includes(word))
    const come = after.filter(word => !before.includes(word))
    if (!gone.length && !come.length) return
    const parts = [
      come.length ? `新增「${list(come)}」` : '',
      gone.length ? `去掉「${list(gone)}」` : '',
    ].filter(Boolean)
    this.push({ scope, field, kind: 'changed', summary: `${label}：${parts.join('，')}` })
  }
  added(scope: string, field: string, summary: string) {
    this.push({ scope, field, kind: 'added', summary })
  }
  removed(scope: string, field: string, summary: string) {
    this.push({ scope, field, kind: 'removed', summary })
  }
}

function diffSteps(
  builder: Builder,
  scope: string,
  label: string,
  before: DirectorStep[],
  after: DirectorStep[],
) {
  const beforeById = new Map(before.map(step => [step.id, step]))
  const afterById = new Map(after.map(step => [step.id, step]))
  for (const step of before)
    if (!afterById.has(step.id))
      builder.removed(scope, `${label}步骤`, `删除步骤「${step.name || '未命名'}」`)
  for (const [index, step] of after.entries()) {
    const field = `${label}步骤「${step.name || '未命名'}」`
    const previous = beforeById.get(step.id)
    if (!previous) {
      builder.added(
        scope,
        `${label}步骤`,
        `新增步骤「${step.name || '未命名'}」（第 ${index + 1} 个）`,
      )
      if (step.file)
        builder.push({
          scope,
          field,
          kind: 'added',
          summary: `素材：${step.file}`,
        })
      continue
    }
    const wasIndex = before.findIndex(item => item.id === step.id)
    if (wasIndex !== index)
      builder.push({
        scope,
        field,
        kind: 'changed',
        summary: `位置：第 ${wasIndex + 1} → 第 ${index + 1}`,
      })
    if ((previous.name || '') !== (step.name || ''))
      builder.push({
        scope,
        field: `${label}步骤`,
        kind: 'changed',
        summary: `步骤改名：「${previous.name}」→「${step.name}」`,
      })
    builder.scalar(scope, field, '素材', previous.file, step.file)
    builder.scalar(scope, field, '类型', previous.kind, step.kind)
    builder.scalar(scope, field, '起点(秒)', previous.start, step.start)
    builder.scalar(scope, field, '终点(秒)', previous.end, step.end)
    builder.scalar(scope, field, '时长(秒)', previous.duration, step.duration)
    builder.scalar(scope, field, '转场', previous.audioOverflow, step.audioOverflow)
    builder.scalar(
      scope,
      field,
      '整句可替换',
      previous.speechSlot ?? false,
      step.speechSlot ?? false,
    )
    builder.scalar(
      scope,
      field,
      '配音气口',
      JSON.stringify(previous.speechWindows || []),
      JSON.stringify(step.speechWindows || []),
    )
    builder.scalar(scope, field, '画面组', previous.stepGroup, step.stepGroup)
    builder.scalar(scope, field, '叠加组', previous.overlayGroup, step.overlayGroup)
    builder.scalar(scope, field, '字幕', previous.caption, step.caption)
    builder.scalar(scope, field, '可选步骤', previous.optional, step.optional)
    builder.wordList(scope, field, '配音', previous.audio || [], step.audio || [])
    const beforeCues = previous.cues?.length || 0
    const afterCues = step.cues?.length || 0
    if (beforeCues !== afterCues)
      builder.push({
        scope,
        field,
        kind: 'changed',
        summary: `商品卡提示：${beforeCues} → ${afterCues} 个`,
      })
    const beforeVariants = previous.overlayVariants?.length || 0
    const afterVariants = step.overlayVariants?.length || 0
    if (beforeVariants !== afterVariants)
      builder.push({
        scope,
        field,
        kind: 'changed',
        summary: `画面方案：${beforeVariants} → ${afterVariants} 套`,
      })
  }
}

function diffProduct(
  builder: Builder,
  scope: string,
  before: DirectorProduct,
  after: DirectorProduct,
) {
  const field = '商品'
  if ((before.name || '') !== (after.name || ''))
    builder.push({
      scope,
      field,
      kind: 'changed',
      summary: `商品名字：「${before.name}」→「${after.name}」`,
    })
  builder.scalar(scope, field, '商品 ID', before.goodsId, after.goodsId)
  builder.wordList(scope, field, '别名', before.aliases || [], after.aliases || [])
  builder.scalar(scope, field, 'B 段画面组', before.stateGroups?.B, after.stateGroups?.B)
  builder.scalar(scope, field, 'C 段画面组', before.stateGroups?.C, after.stateGroups?.C)
  builder.textArea(scope, field, '已确认商品资料', before.facts, after.facts)
  builder.textArea(scope, field, 'B 展示点播说明', before.notes?.B || '', after.notes?.B || '')
  builder.textArea(scope, field, 'C 试戴点播说明', before.notes?.C || '', after.notes?.C || '')
  diffSteps(builder, scope, 'B 段', before.B, after.B)
  diffSteps(builder, scope, 'C 段', before.C, after.C)
}

function diffTray(builder: Builder, before: DirectorTray, after: DirectorTray) {
  const scope = `托盘「${after.name || before.name || '未命名'}」`
  if ((before.name || '') !== (after.name || ''))
    builder.push({
      scope,
      field: '托盘',
      kind: 'changed',
      summary: `托盘改名：「${before.name}」→「${after.name}」`,
    })
  builder.textArea(scope, '托盘', '托盘简介', before.summary || '', after.summary || '')
  builder.scalar(scope, '托盘', 'A 段画面组', before.stateGroup, after.stateGroup)
  builder.scalar(scope, '托盘', '入场转场', before.transitionIn, after.transitionIn)
  builder.scalar(scope, '托盘', '回程转场', before.transitionOut, after.transitionOut)
  diffSteps(builder, scope, 'A 段', before.A, after.A)
  const beforeByProduct = new Map(before.products.map(product => [product.id, product]))
  const afterByProduct = new Map(after.products.map(product => [product.id, product]))
  for (const product of before.products)
    if (!afterByProduct.has(product.id))
      builder.removed(scope, '商品', `删除商品 ${product.id} ${product.name}`)
  for (const product of after.products) {
    const previous = beforeByProduct.get(product.id)
    if (!previous) {
      builder.added(scope, '商品', `新增商品 ${product.id} ${product.name}`)
      continue
    }
    diffProduct(builder, `${scope} · 商品 ${product.id} ${product.name}`, previous, product)
  }
}

/** 全局字段：字段名 → 人话标签。改这里就能让新字段自动出现在差异里。 */
const GLOBAL_LABELS: Array<[keyof DirectorConfig, string, (value: unknown) => string]> = [
  ['scene', 'OBS 场景', show],
  ['canvasWidth', '画布宽', show],
  ['canvasHeight', '画布高', show],
  ['transitionMs', '转场毫秒', show],
  ['normalSeconds', '平时总览停留(秒)', show],
  ['requestSeconds', '有人点播时总览停留(秒)', show],
  ['interruptAOnRequest', '总览可被点播抢占', yn],
  ['queueSkipsOverview', '队列非空时跳过总览', yn],
  ['maxQueue', '队列上限', show],
  ['cooldownSeconds', '单人冷却(秒)', show],
  ['popup', '弹出商品卡', yn],
  ['listen', '监听评论', yn],
  ['ffmpeg', 'ffmpeg 路径', show],
  ['ffprobe', 'ffprobe 路径', show],
]

/**
 * 把两份配置的差别翻译成人话。
 *
 * 空数组 = 没有任何改动，界面据此判断「没有未保存的修改」。
 */
export function diffDirectorConfig(
  before: DirectorConfig,
  after: DirectorConfig,
): DirectorChange[] {
  const builder = new Builder()
  const scope = '全局'

  for (const [key, label, format] of GLOBAL_LABELS)
    builder.scalar(scope, label, label, before[key], after[key], format)
  builder.textArea(scope, 'AI 总纲', 'AI 总纲', before.aiPolicy || '', after.aiPolicy || '')

  const beforeTransition = before.transition
  const afterTransition = after.transition
  builder.scalar(scope, '转场方式', '转场方式', beforeTransition?.mode, afterTransition?.mode)
  builder.scalar(
    scope,
    '转场时长',
    '转场时长(毫秒)',
    beforeTransition?.durationMs,
    afterTransition?.durationMs,
  )
  builder.scalar(
    scope,
    '转场强度',
    '转场强度',
    beforeTransition?.strength,
    afterTransition?.strength,
  )
  builder.scalar(
    scope,
    '回总览转场方式',
    '回总览转场方式',
    beforeTransition?.back?.mode,
    afterTransition?.back?.mode,
  )
  builder.scalar(
    scope,
    '回总览转场时长',
    '回总览转场时长(毫秒)',
    beforeTransition?.back?.durationMs,
    afterTransition?.back?.durationMs,
  )
  builder.scalar(
    scope,
    '回总览转场强度',
    '回总览转场强度',
    beforeTransition?.back?.strength,
    afterTransition?.back?.strength,
  )

  const beforeWords = before.interaction?.modeKeywords
  const afterWords = after.interaction?.modeKeywords
  builder.wordList(
    scope,
    '上头/试戴识别词',
    '「上头/试戴」识别词',
    beforeWords?.C ?? DEFAULT_MODE_KEYWORDS.C ?? [],
    afterWords?.C ?? DEFAULT_MODE_KEYWORDS.C ?? [],
  )
  builder.wordList(
    scope,
    '展示/讲解识别词',
    '「展示/讲解」识别词',
    beforeWords?.B ?? DEFAULT_MODE_KEYWORDS.B ?? [],
    afterWords?.B ?? DEFAULT_MODE_KEYWORDS.B ?? [],
  )
  builder.wordList(
    scope,
    '取消点播识别词',
    '「取消点播」识别词',
    before.interaction?.cancelKeywords ?? DEFAULT_CANCEL_KEYWORDS,
    after.interaction?.cancelKeywords ?? DEFAULT_CANCEL_KEYWORDS,
  )
  builder.scalar(
    scope,
    '艾特模板',
    '回复开头艾特观众',
    before.interaction?.mentionTemplate,
    after.interaction?.mentionTemplate,
  )
  builder.scalar(
    scope,
    '打招呼回复',
    '打招呼回复',
    before.interaction?.greetingReply,
    after.interaction?.greetingReply,
  )
  const beforeScore = before.interaction?.viewerScore ?? DEFAULT_VIEWER_SCORE
  const afterScore = after.interaction?.viewerScore ?? DEFAULT_VIEWER_SCORE
  builder.scalar(scope, '观众记分表', '观众记分表', beforeScore.enabled, afterScore.enabled)
  builder.scalar(
    scope,
    '刷屏句数上限',
    '一分钟超过几句算刷屏',
    beforeScore.floodPerMinute,
    afterScore.floodPerMinute,
  )
  builder.scalar(scope, '静音分数', '累计到多少分就不再回他', beforeScore.muteAt, afterScore.muteAt)
  for (const when of VIEWER_SCORE_ORDER)
    builder.scalar(
      scope,
      `戴分-${when}`,
      `${VIEWER_SCORE_LABELS[when]}每次扣`,
      beforeScore.rules.find(rule => rule.when === when)?.delta ?? 0,
      afterScore.rules.find(rule => rule.when === when)?.delta ?? 0,
    )
  builder.scalar(
    scope,
    '先问展示还是上头',
    '只报编号时先问"展示还是上头"',
    before.interaction?.askModeBeforeDemo ?? true,
    after.interaction?.askModeBeforeDemo ?? true,
  )
  builder.scalar(
    scope,
    '自动回复开关',
    '自动回复',
    before.interaction?.enabled,
    after.interaction?.enabled,
  )
  builder.scalar(
    scope,
    '只观察不发言',
    '只观察不发言',
    before.interaction?.observeOnly,
    after.interaction?.observeOnly,
  )
  builder.scalar(
    scope,
    '公开发言',
    '公开发言',
    before.interaction?.publicReply,
    after.interaction?.publicReply,
  )
  builder.scalar(scope, 'AI 模型', 'AI 模型', before.interaction?.model, after.interaction?.model)

  const beforeTrays = new Map(before.trays.map(tray => [tray.id, tray]))
  const afterTrays = new Map(after.trays.map(tray => [tray.id, tray]))
  for (const tray of before.trays)
    if (!afterTrays.has(tray.id)) builder.removed(scope, '托盘', `删除托盘「${tray.name}」`)
  for (const tray of after.trays) {
    const previous = beforeTrays.get(tray.id)
    if (!previous) {
      builder.added(scope, '托盘', `新增托盘「${tray.name}」`)
      continue
    }
    diffTray(builder, previous, tray)
  }
  return builder.changes
}

/** 一句话概括改了多少处，给状态条用。 */
export function summarizeChanges(changes: DirectorChange[]): string {
  if (!changes.length) return '已保存，没有未保存的修改'
  const added = changes.filter(c => c.kind === 'added').length
  const removed = changes.filter(c => c.kind === 'removed').length
  const changed = changes.length - added - removed
  const parts = [
    changed ? `改了 ${changed} 处` : '',
    added ? `新增 ${added} 处` : '',
    removed ? `删除 ${removed} 处` : '',
  ].filter(Boolean)
  return `有 ${changes.length} 处未保存的修改（${parts.join('，')}）`
}
