const eventLabels = { comment: '评论', enter: '进入', leave: '离开', follow: '关注', gift: '礼物', like: '点赞', event: '其他' }
const tierLabels = { gold: '金级', silver: '银级', neutral: '普通' }
const busyReplies = new Set(['queued', 'generating', 'sending'])
const followSpeeds = [13, 26, 52]
const replyLanguages = [['en', '英语 English'], ['vi', '越南语'], ['tl', '他加禄语 Tagalog'], ['zh', '中文'], ['th', '泰语'], ['ms', '马来语'], ['id', '印尼语'], ['fil', '菲律宾语'], ['es', '西班牙语'], ['pt', '葡萄牙语'], ['ja', '日语'], ['ko', '韩语'], ['fr', '法语'], ['de', '德语'], ['ar', '阿拉伯语']]
const knownReplyLanguages = new Set([...replyLanguages.map(([code]) => code), 'km', 'lo', 'my', 'ta', 'ar', 'ru', 'hi', 'bn', 'hu', 'bg', 'cs', 'da', 'el', 'fi', 'he', 'hr', 'it', 'kn', 'lt', 'mr', 'nl', 'no', 'pl', 'ro', 'sk', 'sl', 'sv', 'te', 'tr', 'uk'])
const replyErrorMessages = {
  TRANSLATION_LANGUAGE_UNKNOWN: '观众语言尚未确定，请先选择回复语言后重试',
  AI_TRANSLATION_UNAVAILABLE: '回复翻译服务尚未连接，请在电脑端检查',
  AI_TRANSLATION_FAILED: '翻译未完成，中文草稿已保留，请重试',
  AI_REQUEST_LIMIT: '本场 AI 请求已达上限，请在电脑端检查额度',
  AI_BUSY: '翻译任务较多，请稍后重试',
  AI_PAUSED: 'AI 已暂停或正在更新设置，请在电脑端检查',
  AI_NOT_ACTIVE: '当前场次不可处理，请先检查采集状态',
  AI_INTERRUPTED: '操作已取消，草稿已保留，请重新确认后重试',
  ATTENTION_EXPIRED: '这条消息已过期或不在当前场次，请处理当前消息',
  PREVIOUS_REQUEST_FAILED: '此前操作失败，请重新提交本次操作',
  SEND_FAILED: '发送未成功，请先核对直播间消息后再重试',
}
const allowedActions = new Set(['attention-pin', 'attention-defer', 'reply-dismiss', 'attention-countdown', 'reply-update', 'reply-approve', 'reply-translate', 'segment-toggle', 'translate-retry'])

export function filterRows(rows, filter = {}) {
  return rows.filter(row => {
    if (filter.events?.length && !filter.events.includes(row.kind)) return false
    if (filter.tiers?.length && !filter.tiers.includes(row.triage?.tier ?? 'neutral')) return false
    for (const [key, field] of [['minPayLevel', 'payLevel'], ['minFansClubLevel', 'fansClubLevel'], ['minFollowers', 'followerCount']]) {
      const threshold = filter[key]
      if (threshold !== '' && threshold !== null && threshold !== undefined && Number.isFinite(Number(threshold))) {
        if (typeof row[field] !== 'number' || !Number.isFinite(row[field]) || row[field] < Number(threshold)) return false
      }
    }
    return true
  })
}

export function visibleRows(snapshot, tab, filter) {
  return filterRows(tab === 'tasks' ? snapshot.tasks : snapshot.rows, filter)
}

export function requestId(cryptoApi = globalThis.crypto) {
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
  if (typeof cryptoApi?.getRandomValues !== 'function') throw Error('此浏览器无法创建操作编号，请更换浏览器')
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function syncDraft(draft, row) {
  const remote = row.reply?.text ?? ''
  if (!draft || draft.text === draft.baseText) return { text: remote, baseText: remote, conflict: false }
  if (draft.text === remote) return { text: remote, baseText: remote, conflict: false }
  return { ...draft, conflict: remote !== draft.baseText }
}

function languageCode(value) {
  const base = typeof value === 'string' && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(value) ? value.toLowerCase().split('-')[0] : undefined
  return knownReplyLanguages.has(base) ? base : undefined
}

function automaticReplyLanguage(row) {
  return languageCode(row.replyLanguageHint?.language) ||
    languageCode(row.kind === 'comment' ? row.translation?.language : row.reply?.targetLanguage ?? row.translation?.language) || 'en'
}

function replyTargetLanguage(row, languageDraft) {
  return languageCode(languageDraft?.selected) || automaticReplyLanguage(row)
}

export function canApprove(row, draft, chineseDraft, languageDraft) {
  return row.reply?.status === 'review' && Boolean(draft?.text?.trim()) && draft.text === row.reply.text && !draft.conflict &&
    (!chineseDraft || chineseDraft.text === (row.reply.chinese ?? '') && !chineseDraft.conflict && !chineseDraft.needsPreview) &&
    !languageDraft?.needsPreview && (!languageDraft || replyTargetLanguage(row, languageDraft) === languageCode(row.reply.targetLanguage)) &&
    !['pending', 'failed'].includes(row.reply.draftTranslation?.status)
}

export function rowCommand(action, row, options = {}) {
  const params = { rowId: row.id }
  if (action === 'retranslate') {
    if (row.kind !== 'comment' || !row.original?.trim() || busyReplies.has(row.reply?.status) || ['sent', 'dismissed'].includes(row.reply?.status)) throw Error('此评论当前不能复译')
    return { action: 'translate-retry', params }
  }
  if (action === 'pin') {
    params.pinned = !options.pinned
    if (options.pinned && Number.isFinite(row.triage?.attention?.pinRevision)) params.expectedPinRevision = row.triage.attention.pinRevision
    return { action: 'attention-pin', params }
  }
  if (action === 'defer') {
    if (row.reply?.status === 'sending') throw Error('回复正在发送，请等待处理完成')
    return { action: 'attention-defer', params: { ...params, requestId: options.requestId ?? requestId() } }
  }
  if (action === 'complete') {
    if (busyReplies.has(row.reply?.status)) throw Error('回复正在处理，请稍后完成任务')
    return { action: 'reply-dismiss', params }
  }
  if (action === 'save') {
    if (row.reply?.status !== 'review') throw Error('草稿状态已改变，请等待刷新')
    if (!options.text?.trim()) throw Error('草稿不能为空')
    return { action: 'reply-update', params: { ...params, text: options.text } }
  }
  if (action === 'translate') {
    if (!options.chinese?.trim()) throw Error('请先填写中文草稿')
    if (busyReplies.has(row.reply?.status)) throw Error('回复正在处理，请稍候')
    if (options.targetLanguage && !replyLanguages.some(([code]) => code === options.targetLanguage)) throw Error('请选择支持的回复语言')
    return { action: 'reply-translate', params: { ...params, chinese: options.chinese, ...(options.targetLanguage ? { targetLanguage: options.targetLanguage } : {}), requestId: options.requestId ?? requestId() } }
  }
  if (action === 'approve') {
    if (!canApprove(row, { text: options.text, conflict: false })) throw Error('请先保存草稿，刷新确认后再发送')
    return { action: 'reply-approve', params: { ...params, expectedText: options.text, requestId: options.requestId ?? requestId() } }
  }
  throw Error('此操作不可用')
}

export function countdownState(snapshot, receivedAt, now) {
  const window = snapshot?.window
  if (!window) return null
  const serverNow = snapshot.serverNow + Math.max(0, now - receivedAt)
  const remaining = window.paused ? window.remainingMs : window.endsAt - serverNow
  return { windowId: window.id, paused: Boolean(window.paused), remainingMs: Math.max(0, remaining ?? 0), active: window.active === true }
}

export function createFollowState() {
  let manual = false
  let held = false
  let focused = false
  let settleUntil = 0
  return {
    pointerDown(now) { held = true; settleUntil = now + 500 },
    pointerEnd(now) { held = false; settleUntil = now + 500 },
    scrolled(now) { settleUntil = now + 500 },
    setManual(value) { manual = value },
    setFocused(value) { focused = value },
    isManual() { return manual },
    canFollow(now) { return !manual && !held && !focused && now >= settleUntil },
  }
}

const failure = (code, message) => ({ ok: false, error: { code, message } })

export function createMobileClient(options = {}) {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
  const pending = new Set()
  let connected = false
  let polling = false
  let epoch = 0
  let accountId
  const changed = () => options.onStatus?.({ connected, pending: new Set(pending), polling })
  async function read(url, init, timeoutMs = 12_000) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetcher(url, { cache: 'no-store', ...init, signal: controller.signal })
      const result = await response.json()
      if (!response.ok && result?.ok !== false) return failure('HTTP_ERROR', `连接失败 (${response.status})`)
      if (!result || typeof result.ok !== 'boolean') throw Error('服务响应无效')
      return result
    } finally { clearTimeout(timeout) }
  }
  async function mutate(url, body, key, timeoutMs = 12_000, keepalive = false) {
    if (!connected) return failure('OFFLINE', '连接中断，操作尚未提交')
    if (pending.has(key)) return failure('PENDING', '正在提交，请稍候')
    pending.add(key); epoch++; changed()
    try {
      const result = await read(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...(keepalive ? { keepalive: true } : {}) }, timeoutMs)
      if (!result.ok) options.onError?.(result.error.message)
      return result
    } catch {
      connected = false
      const result = failure('OFFLINE', '连接中断，操作结果未确认。恢复连接后请先核对状态。')
      options.onError?.(result.error.message)
      return result
    } finally { epoch++; pending.delete(key); changed() }
  }
  return {
    isConnected: () => connected,
    isPending: key => pending.has(key),
    disconnect(message = '网络已断开，操作暂停。恢复网络后会重新连接。') {
      connected = false
      epoch++
      options.onError?.(message)
      changed()
    },
    async poll() {
      if (polling || [...pending].some(key => !String(key).startsWith('control:'))) return false
      polling = true
      const startedEpoch = epoch
      try {
        const result = await read('./api/state')
        if (startedEpoch !== epoch) return false
        if (!result.ok) throw Error(result.error.message)
        const value = result.data
        if (!value || typeof value.accountId !== 'string' || !Array.isArray(value.rows) || !Array.isArray(value.tasks) || !Number.isFinite(value.serverNow)) throw Error('状态响应无效')
        if (accountId && accountId !== value.accountId) throw Error('入口账号已改变，请从电脑重新打开手机入口')
        accountId = value.accountId
        connected = true
        options.onSnapshot?.(value)
        return true
      } catch (error) {
        if (startedEpoch === epoch) {
          connected = false
          options.onError?.(error.message || '连接中断')
        }
        return false
      } finally { polling = false; changed() }
    },
    async command(action, params, key = params.rowId ?? params.windowId) {
      if (!allowedActions.has(action) || !params || Object.hasOwn(params, 'accountId')) return failure('UNSUPPORTED', '此操作不可用')
      return mutate('./api/command', { action, params }, key, ['reply-translate', 'translate-retry'].includes(action) ? 25_000 : 12_000)
    },
    async camera(command) {
      if (!command || typeof command !== 'object' || Array.isArray(command) ||
        !(command.action === 'status' && Object.keys(command).length === 1 || command.action === 'switch' && Object.keys(command).length === 2 && ['android', 'iphone'].includes(command.target))) return failure('UNSUPPORTED', '机位操作不可用')
      return mutate('./api/camera', command, 'control:camera', 20_000)
    },
    async studioMic(action) {
      if (!['status', 'toggle', 'align-open'].includes(action)) return failure('UNSUPPORTED', '麦克风操作不可用')
      return mutate('./api/studio-mic', { action }, 'control:studio-mic', 12_000)
    },
    async xiaomi(command) {
      if (!command || typeof command !== 'object' || Array.isArray(command)) return failure('UNSUPPORTED', '镜头操作不可用')
      const number = (value, low, high) => typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high
      const valid = ['status', 'settings', 'start', 'stop', 'autofocus', 'preview'].includes(command.action) ? Object.keys(command).length === 1
        : command.action === 'zoom' ? Object.keys(command).length === 2 && number(command.ratio, 1, 10)
          : command.action === 'focus' && Object.keys(command).length === 4 && number(command.x, 0, 1) && number(command.y, 0, 1) && typeof command.previewId === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(command.previewId)
      if (!valid) return failure('UNSUPPORTED', '镜头操作不可用')
      return mutate('./api/xiaomi', command, 'control:xiaomi', ['start', 'stop'].includes(command.action) ? 190_000 : 35_000)
    },
    async voice(action, rowId, settings = {}) {
      if (!['start', 'stop', 'cancel'].includes(action) || typeof rowId !== 'string' || !rowId) return failure('UNSUPPORTED', '语音操作不可用')
      return mutate('./api/voice', { action, rowId }, rowId, action === 'stop' ? 55_000 : action === 'start' ? 25_000 : 60_000, settings.keepalive)
    },
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(text, className = '') {
  const node = element('button', className, text)
  node.type = 'button'
  return node
}

function speedControl(label) {
  const select = element('select', 'follow-speed')
  select.setAttribute('aria-label', `${label}跟随速度`)
  for (const [speed, text] of [[13, '慢'], [26, '正常'], [52, '快']]) {
    const option = element('option', '', text)
    option.value = String(speed)
    select.append(option)
  }
  select.value = '26'
  return select
}

function factText(row) {
  if (row.kind === 'gift') {
    const gift = row.gift
    return `${gift?.name || '礼物'}${typeof gift?.count === 'number' ? ` × ${gift.count}` : ''}${typeof gift?.totalCoins === 'number' ? ` · ${gift.totalCoins} 金币` : ''}${gift?.final === false ? ' · 连送中' : ''}`
  }
  if (row.kind === 'like' && typeof row.likeCount === 'number') return `点赞 × ${row.likeCount}`
  return eventLabels[row.kind] ?? '动态'
}

function formatTime(value) {
  if (!Number.isFinite(value)) return ''
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

export function mountMobileDesk() {
  const root = document.getElementById('app')
  if (!root) return
  let snapshot = null
  let receivedAt = 0
  let tab = 'live'
  let filter = {}
  let followRates = { live: 26, tasks: 26 }
  let loadedAccount
  let filterDraft = {}
  let sheetOpen = false
  let lastFrame = 0
  const scrollRemainder = { live: 0, tasks: 0 }
  const autoScrollUntil = { live: 0, tasks: 0 }
  const drafts = new Map()
  const chineseDrafts = new Map()
  const languageDrafts = new Map()
  const transcripts = new Map()
  const retranslationInFlight = new Set()
  let voiceSession = null
  let markerIntent = null
  let markerNotBefore = 0
  let leaving = false
  let cameraState = null, micState = null, xiaomiState = null, xiaomiSettings = null, xiaomiPreview = null
  let controlsInitialized = false
  let xiaomiFocus = null, focusTimer, focusVersion = 0
  let zoomTimer, zoomRefreshTimer, queuedZoom = null, zoomSending = false, zoomRefreshing = false, zoomVersion = 0, lastXiaomiWriteAt = 0, xiaomiWriteBusy = false
  const retryIds = new Map()
  const cards = { live: new Map(), tasks: new Map() }
  const follows = { live: createFollowState(), tasks: createFollowState() }
  const wideMedia = window.matchMedia('(min-width: 700px) and (min-height: 560px)')
  let wide = wideMedia.matches

  const shell = element('div', 'desk')
  const header = element('header', 'header')
  const brand = element('div', 'brand')
  const brandIcon = element('span', 'brand-icon', '助')
  const identity = element('div', 'identity')
  identity.append(element('p', 'eyebrow', 'MOBILE DESK'), element('h1', '', '手机助播台'))
  const filterButton = button('筛选', 'filter-button')
  filterButton.setAttribute('aria-haspopup', 'dialog')
  brand.append(brandIcon, identity, filterButton)
  const status = element('div', 'status')
  const connection = element('span', 'connection', '连接中')
  const account = element('span', 'account', '等待电脑端状态')
  status.append(connection, account)
  const metrics = element('div', 'metrics')
  const online = element('div', 'metric')
  const onlineValue = element('strong', '', '—')
  online.append(element('span', '', '在线人数'), onlineValue)
  const tasksMetric = element('div', 'metric')
  const tasksValue = element('strong', '', '—')
  tasksMetric.append(element('span', '', '待办任务'), tasksValue)
  const capture = element('div', 'metric capture-metric')
  const captureValue = element('strong', '', '等待状态')
  capture.append(element('span', '', '采集状态'), captureValue)
  metrics.append(online, tasksMetric, capture)
  header.append(brand, status, metrics)

  const controls = element('details', 'live-controls')
  controls.append(element('summary', '', '机位与麦克风'))
  const controlBody = element('div', 'live-controls-body')
  const cameraLabel = element('p', 'control-label', 'OBS 直播机位')
  const cameraNotice = element('p', 'control-note', '机位状态未读取')
  const cameraActions = element('div', 'control-actions')
  const iphoneCamera = button('iPhone 机位', 'secondary-button')
  const androidCamera = button('小米机位', 'secondary-button')
  const cameraCheck = button('检查机位', 'text-button')
  cameraActions.append(iphoneCamera, androidCamera, cameraCheck)
  const micLabel = element('p', 'control-label', '直播麦克风 · 豆包录音自动联动')
  const micNotice = element('p', 'control-note', '开始豆包录音前自动静音 TK Studio，结束或取消后恢复原状态。')
  const micActions = element('div', 'control-actions')
  const micToggle = button('切换直播麦克风', 'secondary-button')
  const micCheck = button('检查麦克风控制', 'text-button')
  const micAlign = button('重新读取麦克风状态', 'secondary-button')
  micAlign.hidden = true
  micActions.append(micToggle, micCheck, micAlign)
  const xiaomiLabel = element('p', 'control-label', '小米镜头')
  const xiaomiNotice = element('p', 'control-note', '请先在电脑上配置小米相机密钥')
  const xiaomiActions = element('div', 'control-actions')
  const xiaomiStart = button('开启小米相机', 'secondary-button'), xiaomiStop = button('关闭小米相机', 'secondary-button')
  const xiaomiCheck = button('刷新镜头设置', 'text-button'), xiaomiAuto = button('自动对焦', 'secondary-button')
  xiaomiActions.append(xiaomiStart, xiaomiStop, xiaomiCheck, xiaomiAuto)
  const zoomField = element('label', 'control-zoom', '变焦倍率')
  const zoomInput = element('input'); zoomInput.type = 'number'; zoomInput.min = '1'; zoomInput.max = '10'; zoomInput.step = '0.1'; zoomInput.value = '1'; zoomInput.setAttribute('aria-label', '小米变焦倍率')
  const zoomApply = button('应用变焦', 'secondary-button')
  const zoomSlider = element('input', 'control-zoom-slider'); zoomSlider.type = 'range'; zoomSlider.min = '1'; zoomSlider.max = '10'; zoomSlider.step = '0.01'; zoomSlider.value = '1'; zoomSlider.setAttribute('aria-label', '小米无级变焦')
  zoomInput.step = '0.01'
  zoomField.append(zoomSlider, zoomInput, zoomApply)
  const previewButton = button('刷新预览，点选对焦', 'secondary-button')
  const previewImage = element('img', 'xiaomi-preview'); previewImage.alt = '小米相机预览，点选对焦'; previewImage.hidden = true
  const previewFrame = element('div', 'xiaomi-preview-frame'); previewFrame.hidden = true
  const focusMarker = element('span', 'xiaomi-focus-marker'); focusMarker.hidden = true; focusMarker.setAttribute('aria-label', '对焦位置'); focusMarker.setAttribute('role', 'img')
  previewFrame.append(previewImage, focusMarker)
  const previewNote = element('p', 'control-note', '刷新预览后 2 秒内可点选对焦；变焦后先刷新镜头设置。')
  controlBody.append(cameraLabel, cameraActions, cameraNotice, micLabel, micActions, micNotice, xiaomiLabel, xiaomiActions, zoomField, previewButton, previewFrame, previewNote, xiaomiNotice)
  controls.append(controlBody)

  const notice = element('div', 'notice')
  notice.setAttribute('role', 'status')
  notice.hidden = true
  const noticeText = element('span')
  const retryButton = button('重连', 'text-button')
  notice.append(noticeText, retryButton)
  const voiceBar = element('div', 'voice-session-bar')
  const voiceBarText = element('span')
  const voiceBarActions = element('div', 'voice-session-actions')
  const voiceBarStop = button('结束录音并获取文字', 'primary-button voice-end-button')
  voiceBarStop.addEventListener('click', () => void stopVoice())
  const voiceBarCancel = button('取消当前录音', 'text-button')
  voiceBarCancel.addEventListener('click', () => void cancelVoice())
  voiceBarActions.append(voiceBarStop, voiceBarCancel)
  voiceBar.append(voiceBarText, voiceBarActions)
  voiceBar.hidden = true
  const toolbar = element('section', 'toolbar')
  const heading = element('div', 'list-heading')
  const listTitle = element('h2', '', '实时信息')
  const countText = element('span', 'count-text', '等待消息')
  heading.append(listTitle, countText)
  const filterSummary = element('p', 'filter-summary', '全部客户 · 本机筛选')
  const followTools = element('div', 'follow-tools')
  const followButton = button('Ⅱ 暂停跟随', 'follow-button')
  const liveSpeed = speedControl('实时信息')
  const latestButton = button('↓ 回到最新', 'text-button')
  followTools.append(followButton, liveSpeed, latestButton)
  const countdown = element('div', 'countdown')
  const countdownLabel = element('span', '', '当前批次')
  const countdownValue = element('strong', '', '—')
  const countdownButton = button('暂停清理', 'countdown-button')
  countdown.append(countdownLabel, countdownValue, countdownButton)
  countdown.hidden = true
  toolbar.append(heading, filterSummary, followTools, countdown)

  const viewport = element('main', 'viewport')
  viewport.id = 'message-viewport'
  viewport.setAttribute('aria-label', '实时信息列表')
  const lists = { live: element('div', 'card-list'), tasks: element('div', 'card-list') }
  const empty = element('div', 'empty')
  const emptyIcon = element('div', 'empty-icon', '◌')
  const emptyTitle = element('h3', '', '正在连接助播台')
  const emptyDetail = element('p', '', '请保持与电脑连接同一 Wi-Fi')
  empty.append(emptyIcon, emptyTitle, emptyDetail)
  viewport.append(lists.live, empty)
  const taskViewport = element('main', 'viewport')
  taskViewport.id = 'task-viewport'
  taskViewport.setAttribute('aria-label', '任务列表')
  const taskEmpty = empty.cloneNode(true)
  taskViewport.append(lists.tasks, taskEmpty)
  const taskToolbar = element('section', 'toolbar')
  const taskHeading = element('div', 'list-heading')
  const taskTitle = element('h2', '', '任务')
  const taskCount = element('span', 'count-text', '等待消息')
  taskHeading.append(taskTitle, taskCount)
  const taskFilterSummary = element('p', 'filter-summary', '全部客户 · 本机筛选')
  const taskFollowTools = element('div', 'follow-tools')
  const taskFollowButton = button('Ⅱ 暂停跟随', 'follow-button')
  const taskSpeed = speedControl('任务')
  const taskLatestButton = button('↓ 回到最新', 'text-button')
  taskFollowTools.append(taskFollowButton, taskSpeed, taskLatestButton)
  taskToolbar.append(taskHeading, taskFilterSummary, taskFollowTools, countdown)
  const workspace = element('div', 'workspace')
  const panes = { live: element('section', 'desk-pane pane-live'), tasks: element('section', 'desk-pane pane-tasks') }
  panes.live.setAttribute('aria-label', '实时信息')
  panes.tasks.setAttribute('aria-label', '任务')
  panes.live.append(toolbar, viewport)
  panes.tasks.append(taskToolbar, taskViewport)
  workspace.append(panes.tasks, panes.live)
  const viewports = { live: viewport, tasks: taskViewport }
  const empties = { live: empty, tasks: taskEmpty }
  const countTexts = { live: countText, tasks: taskCount }
  const filterSummaries = { live: filterSummary, tasks: taskFilterSummary }
  const followButtons = { live: followButton, tasks: taskFollowButton }
  const speedInputs = { live: liveSpeed, tasks: taskSpeed }
  const latestButtons = { live: latestButton, tasks: taskLatestButton }
  const markerBar = element('section', 'marker-bar')
  markerBar.setAttribute('aria-label', '片段打点')
  const markerInfo = element('div', 'marker-info')
  const markerLabel = element('span', 'marker-label', '直播片段')
  const markerStatus = element('strong', 'marker-status', '等待电脑端状态')
  markerInfo.append(markerLabel, markerStatus)
  const markerButton = button('开始打点', 'marker-button')
  markerButton.disabled = true
  markerBar.append(markerInfo, markerButton)
  const navigation = element('nav', 'bottom-nav')
  navigation.setAttribute('aria-label', '主导航')
  const liveTab = button('', 'nav-tab active')
  liveTab.setAttribute('aria-label', '实时信息')
  liveTab.append(element('span', 'nav-icon', '☷'), element('span', '', '实时信息'))
  const taskTab = button('', 'nav-tab')
  taskTab.setAttribute('aria-label', '任务')
  const taskBadge = element('span', 'nav-badge', '0')
  const taskIcon = element('span', 'nav-icon', '☑')
  taskIcon.append(taskBadge)
  taskTab.append(taskIcon, element('span', '', '任务'))
  liveTab.setAttribute('aria-current', 'page')
  navigation.append(liveTab, taskTab)
  shell.append(header, controls, notice, voiceBar, workspace, markerBar, navigation)
  root.replaceChildren(shell)

  const overlay = element('div', 'sheet-overlay')
  overlay.hidden = true
  const sheet = element('section', 'filter-sheet')
  sheet.setAttribute('role', 'dialog')
  sheet.setAttribute('aria-modal', 'true')
  sheet.setAttribute('aria-labelledby', 'filter-title')
  const sheetHeader = element('div', 'sheet-header')
  const sheetTitle = element('h2', '', '客户筛选')
  sheetTitle.id = 'filter-title'
  const closeSheet = button('✕', 'close-button')
  closeSheet.setAttribute('aria-label', '关闭筛选')
  sheetHeader.append(sheetTitle, closeSheet)
  const sheetDescription = element('p', 'sheet-description', '只影响这台手机的显示')
  const filterForm = element('form', 'filter-form')
  const eventGroup = element('fieldset')
  eventGroup.append(element('legend', '', '事件类型'))
  const events = element('div', 'filter-chips')
  const eventInputs = new Map()
  for (const [value, label] of Object.entries(eventLabels)) {
    const chip = element('label', 'filter-chip')
    const input = element('input')
    input.type = 'checkbox'; input.value = value; input.name = 'event'
    chip.append(input, element('span', '', label)); events.append(chip); eventInputs.set(value, input)
  }
  eventGroup.append(events)
  const tierGroup = element('fieldset')
  tierGroup.append(element('legend', '', '客户层级'))
  const tiers = element('div', 'filter-chips')
  const tierInputs = new Map()
  for (const [value, label] of Object.entries(tierLabels)) {
    const chip = element('label', `filter-chip tier-${value}`)
    const input = element('input'); input.type = 'checkbox'; input.value = value; input.name = 'tier'
    chip.append(input, element('span', '', label)); tiers.append(chip); tierInputs.set(value, input)
  }
  tierGroup.append(tiers)
  const numericGroup = element('fieldset', 'thresholds')
  numericGroup.append(element('legend', '', '最低门槛'))
  const numericInputs = new Map()
  for (const [key, label] of [['minPayLevel', '消费等级'], ['minFansClubLevel', '粉丝团等级'], ['minFollowers', '粉丝数']]) {
    const wrapper = element('label', 'threshold')
    const input = element('input'); input.type = 'number'; input.inputMode = 'numeric'; input.min = '0'; input.step = '1'; input.placeholder = '不限'; input.name = key
    wrapper.append(element('span', '', label), input); numericGroup.append(wrapper); numericInputs.set(key, input)
  }
  const sheetNote = element('p', 'sheet-note', '设置门槛后，未知数值的客户将不显示。未选类型或层级时显示全部。')
  const sheetActions = element('div', 'sheet-actions')
  const resetFilters = button('重置', 'secondary-button')
  const applyFilters = button('应用筛选', 'primary-button')
  applyFilters.type = 'submit'
  sheetActions.append(resetFilters, applyFilters)
  filterForm.append(eventGroup, tierGroup, numericGroup, sheetNote, sheetActions)
  sheet.append(element('div', 'sheet-handle'), sheetHeader, sheetDescription, filterForm)
  overlay.append(sheet)
  root.append(overlay)

  function showNotice(message, error = true) {
    noticeText.textContent = message
    notice.hidden = !message
    notice.classList.toggle('is-error', error)
    retryButton.hidden = client.isConnected()
  }
  const client = createMobileClient({
    onSnapshot(value) {
      if (markerIntent && markerIntent.phase !== 'pending') {
        const changedScene = value.accountId !== markerIntent.accountId || value.sessionId !== markerIntent.sessionId || !value.collecting
        const changedMarker = (value.marker?.open?.id ?? null) !== markerIntent.expectedOpenSegmentId
        if (changedScene || markerIntent.phase === 'confirmed' || changedMarker) markerIntent = null
      }
      snapshot = value
      receivedAt = Date.now()
      if (loadedAccount !== value.accountId) {
        loadedAccount = value.accountId
        try { filter = JSON.parse(localStorage.getItem(`oba-mobile-filter:${loadedAccount}`) || '{}') ?? {} } catch { filter = {} }
        if (!filter || typeof filter !== 'object' || Array.isArray(filter)) filter = {}
        let savedSpeeds
        try { savedSpeeds = JSON.parse(localStorage.getItem(`oba-mobile-follow:${loadedAccount}`) || '{}') } catch {}
        for (const mode of ['live', 'tasks']) {
          followRates[mode] = followSpeeds.includes(savedSpeeds?.[mode]) ? savedSpeeds[mode] : 26
          speedInputs[mode].value = String(followRates[mode])
        }
      }
      if (!notice.hidden && notice.dataset.connection === 'true') { notice.hidden = true; delete notice.dataset.connection }
      render()
      if (voiceSession && !voiceSession.cleanupRequested && (voiceSession.accountId !== value.accountId || voiceSession.sessionId !== value.sessionId || !value.collecting || !value.tasks.some(row => row.id === voiceSession.rowId))) {
        voiceSession.cleanupRequested = true
        voiceSession.cancelRequested = true
        queueMicrotask(() => void cancelVoice())
      }
    },
    onStatus() {
      renderStatus()
      renderCards()
    },
    onError(message) { showNotice(message); if (!client.isConnected()) notice.dataset.connection = 'true' },
  })

  function renderControls() {
    const connected = client.isConnected()
    const cameraBusy = client.isPending('control:camera')
    for (const target of [iphoneCamera, androidCamera, cameraCheck]) target.disabled = !connected || cameraBusy
    iphoneCamera.setAttribute('aria-pressed', String(connected && cameraState?.selected === 'iphone'))
    androidCamera.setAttribute('aria-pressed', String(connected && cameraState?.selected === 'android'))
    const micBusy = client.isPending('control:studio-mic')
    micToggle.disabled = !connected || micBusy || Boolean(voiceSession) || ['doubao', 'unknown'].includes(micState?.routeState)
    micCheck.disabled = !connected || micBusy
    micAlign.textContent = micState?.backend === 'api' ? '重新读取麦克风状态' : '我已恢复 TK 开麦，重新对齐'
    micAlign.hidden = micState?.routeState !== 'unknown'
    micAlign.disabled = !connected || micBusy || Boolean(voiceSession)
    const xiaomiBusy = xiaomiWriteBusy || client.isPending('control:xiaomi')
    for (const target of [xiaomiStart, xiaomiStop, xiaomiCheck]) target.disabled = !connected || xiaomiBusy
    xiaomiAuto.disabled = !connected || xiaomiBusy || !xiaomiSettings?.available || xiaomiSettings.focus_supported === false
    const zoomBusy = zoomSending || zoomRefreshing || queuedZoom !== null
    zoomInput.disabled = !connected || !xiaomiSettings?.available || xiaomiBusy && !zoomBusy
    zoomSlider.disabled = zoomInput.disabled
    zoomApply.disabled = zoomInput.disabled
    previewButton.disabled = !connected || xiaomiBusy || !xiaomiSettings?.available
    if (controls.open && connected && !controlsInitialized) {
      controlsInitialized = true
      queueMicrotask(() => { void runCamera({ action: 'status' }); void runMic('status') })
    }
  }
  async function runCamera(command) {
    if (client.isPending('control:camera')) return
    const result = await client.camera(command)
    cameraState = result.ok ? result.data : null
    cameraNotice.textContent = result.ok ? result.data.message : result.error.message
    renderControls()
  }
  async function runMic(action) {
    if (client.isPending('control:studio-mic')) return
    const result = await client.studioMic(action)
    if (result.ok) {
      micState = result.data
      micNotice.textContent = result.data.backend === 'api'
        ? result.data.routeState === 'unknown' ? `${result.data.message}；请重新读取麦克风状态以恢复联动` : result.data.routeState === 'doubao' ? `${result.data.message}；豆包录音结束后恢复原状态` : result.data.message
        : result.data.routeState === 'doubao' ? '豆包录音联动中，结束或取消后自动切回直播' : result.data.routeState === 'unknown' ? '热键已发送或恢复结果未确认；手动恢复 TK 开麦后重新对齐' : action === 'align-open' ? '已按 TK 开麦状态重新对齐' : result.data.message
    } else {
      if (micState?.backend === 'api' && !['STUDIO_MIC_API_BUSY', 'STUDIO_MIC_API_INVALID_COMMAND', 'STUDIO_MIC_VOICE_BUSY'].includes(result.error.code)) micState = { ...micState, micState: 'unknown', routeState: 'unknown' }
      micNotice.textContent = result.error.message
    }
    renderControls()
  }
  function cameraNow() {
    return snapshot ? snapshot.serverNow + Math.max(0, Date.now() - receivedAt) : Date.now()
  }
  function clearXiaomiFocus() {
    focusVersion++; clearTimeout(focusTimer); xiaomiFocus = null; focusMarker.hidden = true
  }
  function invalidateXiaomiPreview(hide = false, clearFocus = true) {
    xiaomiPreview = null
    if (clearFocus) clearXiaomiFocus()
    if (hide) { previewImage.hidden = true; previewFrame.hidden = true }
  }
  function cancelZoom() {
    zoomVersion++; clearTimeout(zoomTimer); clearTimeout(zoomRefreshTimer); zoomTimer = undefined; queuedZoom = null; zoomRefreshing = false
  }
  function focusResult(settings) {
    if (!xiaomiFocus || !settings) return
    const result = settings.last_focus_result
    if (settings.focus_pending || result === 'pending' || settings.focus_state === 'focusing') {
      focusMarker.dataset.state = 'pending'; xiaomiNotice.textContent = '对焦中，等待设备返回结果'; return
    }
    const terminal = ['focused', 'not_focused', 'timeout', 'failed', 'cancelled'].includes(result)
    if (!terminal) { xiaomiNotice.textContent = `对焦结果未确认${result ? ` · ${result}` : ''}${settings.focus_state ? ` · 状态 ${settings.focus_state}` : ''}`; return }
    const wasDone = xiaomiFocus.done
    clearTimeout(focusTimer); xiaomiFocus.done = true
    focusMarker.dataset.state = result === 'focused' ? 'focused' : result === 'cancelled' ? 'cancelled' : 'failed'
    xiaomiNotice.textContent = result === 'focused' ? '设备确认已合焦（focused）' : result === 'cancelled' ? '对焦已取消（cancelled）' : `对焦未合焦（${result}）`
    const version = focusVersion
    if (!wasDone && controls.open && client.isConnected()) void runXiaomi({ action: 'preview' }, () => version === focusVersion, true)
  }
  function observeFocus(version, remaining = 6) {
    clearTimeout(focusTimer)
    focusTimer = setTimeout(async () => {
      if (version !== focusVersion || !xiaomiFocus || xiaomiFocus.done || !controls.open || !client.isConnected()) return
      if (xiaomiFocus.deadline <= Date.now() || remaining <= 0) { xiaomiNotice.textContent = '对焦结果尚未确认，可刷新镜头设置检查'; return }
      if (!xiaomiWriteBusy && !client.isPending('control:xiaomi')) await runXiaomi({ action: 'settings' }, () => version === focusVersion)
      if (version === focusVersion && xiaomiFocus && !xiaomiFocus.done) observeFocus(version, remaining - 1)
    }, 800)
  }
  async function runXiaomi(command, current = () => !leaving, preserveFocus = false) {
    if (leaving || xiaomiWriteBusy || client.isPending('control:xiaomi') || !current()) return
    const write = ['zoom', 'start', 'stop', 'autofocus', 'focus'].includes(command.action)
    if (['start', 'stop', 'autofocus'].includes(command.action)) { cancelZoom(); invalidateXiaomiPreview(['start', 'stop'].includes(command.action)) }
    else if (command.action === 'preview' && !preserveFocus) invalidateXiaomiPreview()
    else if (command.action === 'zoom') invalidateXiaomiPreview()
    let result
    if (write) { xiaomiWriteBusy = true; renderControls() }
    try {
      if (write) {
        const remaining = Math.max(0, 250 - (Date.now() - lastXiaomiWriteAt))
        if (remaining) await new Promise(resolve => setTimeout(resolve, remaining))
        if (leaving || !current()) return
        lastXiaomiWriteAt = Date.now()
      }
      result = await client.xiaomi(command)
    } finally { if (write) xiaomiWriteBusy = false; renderControls() }
    if (leaving || !current()) return result
    if (!result.ok) { xiaomiNotice.textContent = result.error.message; if (['status', 'settings'].includes(command.action)) xiaomiSettings = null; if (command.action === 'focus') focusMarker.dataset.state = 'cancelled'; renderControls(); return result }
    if (result.data.camera) {
      xiaomiState = result.data.camera
      if (['off', 'offline'].includes(xiaomiState.state)) invalidateXiaomiPreview(true)
    }
    if (result.data.settings) {
      const previousZoom = xiaomiSettings?.observed_zoom
      xiaomiSettings = result.data.settings
      zoomInput.min = zoomSlider.min = String(xiaomiSettings.zoom_min ?? 1); zoomInput.max = zoomSlider.max = String(xiaomiSettings.zoom_max ?? 10)
      if (typeof xiaomiSettings.observed_zoom === 'number' && queuedZoom === null && !zoomSending) zoomInput.value = zoomSlider.value = String(xiaomiSettings.observed_zoom)
      if (typeof previousZoom === 'number' && typeof xiaomiSettings.observed_zoom === 'number' && Math.abs(previousZoom - xiaomiSettings.observed_zoom) > 0.0001) invalidateXiaomiPreview()
    }
    if (result.data.preview) { xiaomiPreview = result.data.preview; previewImage.src = xiaomiPreview.dataUrl; previewImage.hidden = false; previewFrame.hidden = false }
    const states = { off: '小米相机已关闭', ready: '小米相机已就绪', capturing: '小米相机已连接视频消费者', offline: '小米手机离线', unknown: '相机状态未确认' }
    if (!preserveFocus) xiaomiNotice.textContent = result.data.preview ? '预览已更新，可在图像内点选对焦' : result.data.operation ? result.data.operation.focus_submitted ? '对焦已提交，等待设备返回结果' : '镜头指令已提交，请刷新设置核对' : `${states[xiaomiState?.state] || '镜头设置已读取'}${typeof xiaomiSettings?.observed_zoom === 'number' ? ` · 实际倍率 ${xiaomiSettings.observed_zoom}×` : ''}`
    if (command.action === 'focus' && result.data.operation?.focus_submitted) observeFocus(focusVersion)
    if (result.data.settings && xiaomiFocus) focusResult(result.data.settings)
    renderControls()
    return result
  }
  async function refreshZoomPreview(version, target, remaining = 4) {
    const current = () => !leaving && version === zoomVersion && queuedZoom === null && !zoomSending && controls.open && client.isConnected()
    if (!current()) return
    zoomRefreshing = true
    try {
      if (xiaomiWriteBusy || client.isPending('control:xiaomi')) { if (remaining > 1) zoomRefreshTimer = setTimeout(() => void refreshZoomPreview(version, target, remaining - 1), 400); return }
      const settings = await runXiaomi({ action: 'settings' }, current)
      if (!current() || !settings?.ok) return
      const observed = settings.data.settings?.observed_zoom
      if (typeof observed === 'number' && Math.abs(observed - target) <= 0.05) await runXiaomi({ action: 'preview' }, current)
      else if (remaining > 1) zoomRefreshTimer = setTimeout(() => void refreshZoomPreview(version, target, remaining - 1), 400)
    } finally { zoomRefreshing = false; renderControls() }
  }
  async function flushZoom() {
    clearTimeout(zoomTimer); zoomTimer = undefined
    if (leaving || queuedZoom === null || zoomSending || !client.isConnected()) return
    if (xiaomiWriteBusy || client.isPending('control:xiaomi')) { zoomTimer = setTimeout(() => void flushZoom(), 300); return }
    const target = queuedZoom, hadPreview = !previewImage.hidden
    queuedZoom = null; zoomSending = true
    const result = await runXiaomi({ action: 'zoom', ratio: target })
    zoomSending = false; renderControls()
    if (queuedZoom !== null) { if (queuedZoom === target && result?.ok) queuedZoom = null; else { zoomTimer = setTimeout(() => void flushZoom(), Math.max(0, 300 - (Date.now() - lastXiaomiWriteAt))); return } }
    if (result?.ok && hadPreview) { const version = zoomVersion; zoomRefreshTimer = setTimeout(() => void refreshZoomPreview(version, target), 400) }
  }
  function queueZoom(value, final = false) {
    const ratio = Number(value), minimum = Number(zoomSlider.min), maximum = Number(zoomSlider.max)
    if (!Number.isFinite(ratio) || ratio < minimum || ratio > maximum || leaving || !client.isConnected()) return
    zoomVersion++; clearTimeout(zoomRefreshTimer); queuedZoom = ratio
    zoomInput.value = zoomSlider.value = String(ratio)
    invalidateXiaomiPreview(); renderControls()
    if (final) void flushZoom()
    else if (!zoomTimer && !zoomSending) zoomTimer = setTimeout(() => void flushZoom(), 300)
  }
  iphoneCamera.addEventListener('click', () => void runCamera({ action: 'switch', target: 'iphone' }))
  androidCamera.addEventListener('click', () => void runCamera({ action: 'switch', target: 'android' }))
  cameraCheck.addEventListener('click', () => void runCamera({ action: 'status' }))
  micToggle.addEventListener('click', () => void runMic('toggle'))
  micCheck.addEventListener('click', () => void runMic('status'))
  micAlign.addEventListener('click', () => void runMic('align-open'))
  xiaomiStart.addEventListener('click', () => void runXiaomi({ action: 'start' }))
  xiaomiStop.addEventListener('click', () => void runXiaomi({ action: 'stop' }))
  xiaomiCheck.addEventListener('click', async () => { await runXiaomi({ action: 'status' }); await runXiaomi({ action: 'settings' }) })
  xiaomiAuto.addEventListener('click', () => void runXiaomi({ action: 'autofocus' }))
  zoomApply.addEventListener('click', () => queueZoom(zoomInput.value, true))
  zoomSlider.addEventListener('input', () => queueZoom(zoomSlider.value))
  zoomSlider.addEventListener('change', () => queueZoom(zoomSlider.value, true))
  zoomSlider.addEventListener('pointerup', () => { if (queuedZoom !== null) void flushZoom() })
  previewButton.addEventListener('click', () => void runXiaomi({ action: 'preview' }))
  previewImage.addEventListener('click', event => {
    if (xiaomiWriteBusy || client.isPending('control:xiaomi') || zoomSending || queuedZoom !== null) return
    if (!xiaomiPreview || xiaomiPreview.expiresAt <= cameraNow()) { if (!xiaomiFocus || xiaomiFocus.done) clearXiaomiFocus(); xiaomiNotice.textContent = '预览已过期，请刷新图像后再点选对焦'; return }
    const rect = previewImage.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
    const preview = xiaomiPreview
    clearXiaomiFocus(); xiaomiPreview = null
    xiaomiFocus = { x, y, deadline: Date.now() + 6000, width: previewImage.naturalWidth, height: previewImage.naturalHeight, done: false }
    focusMarker.style.left = `${x * 100}%`; focusMarker.style.top = `${y * 100}%`; focusMarker.dataset.state = 'pending'; focusMarker.hidden = false
    xiaomiNotice.textContent = '正在提交对焦位置'
    const version = focusVersion
    void runXiaomi({ action: 'focus', x, y, previewId: preview.id }, () => version === focusVersion)
  })
  previewImage.addEventListener('load', () => { if (xiaomiFocus && (xiaomiFocus.width !== previewImage.naturalWidth || xiaomiFocus.height !== previewImage.naturalHeight)) clearXiaomiFocus() })
  previewImage.addEventListener('error', () => invalidateXiaomiPreview(true))
  controls.addEventListener('toggle', () => { if (!controls.open) clearXiaomiFocus(); renderControls() })
  window.addEventListener('resize', () => { invalidateXiaomiPreview(); cancelZoom() })


  function renderStatus() {
    const connected = client.isConnected()
    connection.textContent = connected ? '已连接' : snapshot ? '连接中断' : '连接中'
    connection.classList.toggle('connected', connected)
    connection.classList.toggle('offline', !connected && Boolean(snapshot))
    account.textContent = snapshot?.accountName || '等待电脑端状态'
    onlineValue.textContent = typeof snapshot?.room?.onlineCount === 'number' ? snapshot.room.onlineCount.toLocaleString('zh-CN') : '—'
    onlineValue.classList.toggle('stale-value', snapshot?.room?.status !== 'fresh')
    online.title = snapshot?.room?.status === 'stale' ? '人数为上次观测值' : '平台已观测的在线人数'
    tasksValue.textContent = snapshot ? String(snapshot.totalTasks) : '—'
    taskBadge.textContent = snapshot ? String(snapshot.totalTasks) : '0'
    taskBadge.hidden = !snapshot?.totalTasks
    const captureActive = snapshot?.captureActive ?? snapshot?.collecting
    const storageError = snapshot?.captureStatus === 'storage-error'
    captureValue.textContent = snapshot ? captureActive ? storageError ? '采集中·保存异常' : '采集中' : '已停止' : '等待状态'
    captureValue.title = captureValue.textContent
    captureValue.classList.toggle('collecting', Boolean(captureActive))
    capture.classList.toggle('has-error', storageError)
    voiceBar.hidden = !voiceSession
    if (voiceSession) {
      voiceBarText.textContent = `${voiceSession.phase === 'recording' ? '电脑麦克风录音中' : voiceSession.phase === 'stopping' ? '正在识别语音' : voiceSession.phase === 'starting' ? '正在开启电脑麦克风' : voiceSession.phase === 'cancelling' ? '正在取消录音' : '录音状态待确认'} · ${voiceSession.nickname}`
      voiceBarStop.disabled = !connected || !snapshot?.collecting || voiceSession.phase !== 'recording' || client.isPending(voiceSession.rowId)
      voiceBarStop.setAttribute('aria-busy', String(['starting', 'stopping'].includes(voiceSession.phase)))
      voiceBarCancel.disabled = !connected || voiceSession.phase === 'cancelling' || voiceSession.cancelRequested && client.isPending(voiceSession.rowId)
    }
    renderCountdown()
    renderMarker()
    renderControls()
  }

  function renderMarker() {
    const marker = snapshot?.marker
    const open = marker?.open
    const active = Boolean(snapshot?.collecting && snapshot.sessionId && marker)
    const pending = markerIntent && markerIntent.phase !== 'uncertain'
    const uncertain = markerIntent?.phase === 'uncertain'
    markerBar.dataset.recording = String(Boolean(open))
    markerBar.classList.toggle('is-recording', Boolean(open))
    markerBar.classList.toggle('is-uncertain', uncertain)
    markerLabel.textContent = uncertain ? '打点结果待确认' : open ? '片段进行中' : '直播片段'
    let text = !snapshot ? '等待电脑端状态' : active ? `已完成 ${marker?.completed ?? 0} 段` : snapshot.captureStatus === 'storage-error' ? '保存异常，打点暂不可用' : (snapshot.captureActive ?? snapshot.collecting) ? '正在同步打点状态' : '请在电脑端开始采集'
    if (open && active) {
      const elapsed = Math.max(0, Math.floor((snapshot.serverNow + Math.max(0, Date.now() - receivedAt) - open.startedAt) / 1000))
      text = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')} · 已完成 ${marker.completed} 段`
    }
    markerStatus.textContent = uncertain ? `${text} · 待确认` : text
    const ending = uncertain ? Boolean(markerIntent.expectedOpenSegmentId) : Boolean(open)
    const label = ending ? '结束打点' : '开始打点'
    markerButton.setAttribute('aria-label', label)
    markerButton.setAttribute('aria-busy', String(Boolean(pending)))
    markerButton.textContent = pending ? markerIntent.phase === 'confirmed' ? '核对打点状态…' : '提交打点中…' : uncertain ? `重试${label}` : label
    markerButton.disabled = !client.isConnected() || !active || Boolean(pending) || client.isPending('segment-toggle') || Date.now() < markerNotBefore
  }

  function renderCountdown() {
    const state = countdownState(snapshot, receivedAt, Date.now())
    countdown.hidden = !state
    if (!state) return
    const seconds = Math.ceil(state.remainingMs / 1000)
    countdownLabel.textContent = !client.isConnected() ? '上次批次状态' : state.active ? state.paused ? '清理已暂停' : seconds > 0 ? '本批清理倒计时' : '等待批次更新' : '批次已结束'
    countdownValue.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    countdown.classList.toggle('paused', state.paused)
    countdownButton.textContent = client.isPending(state.windowId) ? '提交中…' : state.paused ? '继续清理' : '暂停清理'
    countdownButton.disabled = !client.isConnected() || !state.active || !snapshot.collecting || client.isPending(state.windowId) || (!state.paused && seconds === 0)
  }

  function createCard(row, mode) {
    const node = element('article', 'message-card')
    node.dataset.rowId = row.id
    const top = element('div', 'card-top')
    const avatar = element('span', 'avatar')
    const nameBlock = element('div', 'name-block')
    const name = element('strong', 'nickname')
    const handle = element('span', 'handle')
    nameBlock.append(name, handle)
    const time = element('time', 'time')
    top.append(avatar, nameBlock, time)
    const tags = element('div', 'tags')
    const tier = element('span', 'tier-tag')
    const fact = element('span', 'event-tag')
    const pinTag = element('span', 'pin-tag', '已钉住')
    tags.append(tier, fact, pinTag)
    const original = element('p', 'original')
    const translation = element('p', 'translation')
    const translationNote = element('p', 'translation-note')
    const viewerFacts = element('div', 'viewer-facts')
    const replyStatus = element('p', 'reply-state')
    const actions = element('div', 'card-actions')
    const pin = button('钉住', 'action-button pin-button')
    pin.dataset.action = 'pin'
    actions.append(pin)
    const retranslate = button('DeepSeek 复译', 'action-button'); retranslate.dataset.action = 'retranslate'
    actions.append(retranslate)
    const defer = button('稍后', 'action-button'); defer.dataset.action = 'defer'
    const complete = button('完成', 'action-button complete-button'); complete.dataset.action = 'complete'
    if (mode === 'tasks') actions.append(defer, complete)
    const draftBox = element('div', 'draft-box')
    const chineseBox = element('div', 'chinese-draft-box')
    const chineseLabel = element('label', 'draft-label', '中文回复草稿')
    const chineseInput = element('textarea', 'draft-input chinese-draft-input')
    chineseInput.rows = 2; chineseInput.maxLength = 1000; chineseInput.placeholder = '用中文填写，或使用电脑麦克风输入'
    chineseInput.id = `chinese-${requestId()}`
    chineseInput.setAttribute('aria-label', '中文回复草稿')
    chineseLabel.htmlFor = chineseInput.id
    const voiceTools = element('div', 'voice-tools')
    const record = button('使用电脑麦克风', 'secondary-button')
    const clearChinese = button('清空中文草稿', 'text-button clear-chinese-draft')
    const cancelRecord = button('取消录音', 'text-button')
    const voiceNote = element('p', 'voice-note', '使用服务电脑的麦克风，识别后仅填入中文草稿。')
    const transcript = element('p', 'voice-transcript')
    const appendTranscript = button('追加识别文字', 'secondary-button')
    appendTranscript.hidden = true; transcript.hidden = true; cancelRecord.hidden = true
    const translate = button('翻译并更新预览', 'secondary-button')
    translate.dataset.action = 'translate'
    const languageField = element('label', 'reply-language-field', '回复语言')
    const languagePicker = element('select', 'reply-language-picker')
    languagePicker.setAttribute('aria-label', '回复语言')
    for (const [value, label] of [['', '自动 / 使用已知语言'], ...replyLanguages]) {
      const option = element('option', '', label); option.value = value; languagePicker.append(option)
    }
    languageField.append(languagePicker)
    const languageHint = element('p', 'reply-language-hint')
    voiceTools.append(record, clearChinese, cancelRecord)
    chineseBox.append(chineseLabel, chineseInput, voiceTools, voiceNote, transcript, appendTranscript, languageField, languageHint, translate)
    const sendingGroup = element('div', 'sending-draft-group')
    const draftLabel = element('label', 'draft-label', '发送内容草稿')
    const textarea = element('textarea', 'draft-input')
    textarea.rows = 3
    textarea.id = `draft-${mode}-${requestId()}`
    textarea.setAttribute('aria-label', '回复草稿')
    draftLabel.htmlFor = textarea.id
    const draftHint = element('p', 'draft-hint')
    const draftActions = element('div', 'draft-actions')
    const save = button('保存草稿', 'secondary-button'); save.dataset.action = 'save'
    const approve = button('确认发送', 'primary-button'); approve.dataset.action = 'approve'
    draftActions.append(save, approve)
    sendingGroup.append(draftLabel, textarea, draftHint, draftActions)
    draftBox.append(chineseBox, sendingGroup)
    draftBox.hidden = true
    node.append(top, tags, original, translation, translationNote, viewerFacts, replyStatus, actions, draftBox)
    const card = { node, name, handle, avatar, time, tier, fact, pinTag, original, translation, translationNote, retranslate, viewerFacts, replyStatus, pin, defer, complete, draftBox, textarea, draftHint, save, approve, row, mode, chineseInput, record, clearChinese, cancelRecord, transcript, appendTranscript, translate, voiceNote, sendingGroup, languagePicker, languageHint }
    node.addEventListener('click', event => {
      const target = event.target.closest('button[data-action]')
      if (target && !target.disabled) void runRowAction(card, target.dataset.action)
    })
    textarea.addEventListener('input', () => {
      const draft = drafts.get(card.row.id) ?? syncDraft(undefined, card.row)
      draft.text = textarea.value
      drafts.set(card.row.id, draft)
      updateCard(card, card.row)
    })
    chineseInput.addEventListener('input', () => {
      const draft = chineseDraftFor(card.row)
      draft.text = chineseInput.value
      chineseDrafts.set(card.row.id, draft)
      updateCard(card, card.row)
    })
    clearChinese.addEventListener('click', () => {
      if (clearChinese.disabled) return
      chineseDrafts.set(card.row.id, { ...chineseDraftFor(card.row), text: '', needsPreview: true })
      retryIds.delete(`${card.row.id}:translate`)
      updateCard(card, card.row)
    })
    languagePicker.addEventListener('change', () => {
      const language = languageDraftFor(card.row)
      if (language.selected !== languagePicker.value) {
        language.selected = languagePicker.value
        language.needsPreview = true
        language.revision++
      }
      updateCard(card, card.row)
    })
    record.addEventListener('click', () => {
      if (!record.disabled) void (voiceSession?.rowId === card.row.id ? stopVoice() : startVoice(card))
    })
    cancelRecord.addEventListener('click', () => void cancelVoice())
    appendTranscript.addEventListener('click', () => {
      const text = transcripts.get(card.row.id)
      if (!text) return
      const draft = chineseDraftFor(card.row)
      const combined = [draft.text, text].filter(Boolean).join('\n')
      if (combined.length > 1000) { showNotice('追加后超过 1000 字，请先精简中文草稿'); return }
      chineseDrafts.set(card.row.id, { ...draft, text: combined })
      transcripts.delete(card.row.id)
      updateCard(card, card.row)
    })
    return card
  }

  function chineseDraftFor(row) {
    const previous = chineseDrafts.get(row.id)
    const draft = syncDraft(previous, { reply: { text: row.reply?.chinese ?? '' } })
    if (previous?.needsPreview) draft.needsPreview = true
    chineseDrafts.set(row.id, draft)
    return draft
  }

  function languageDraftFor(row) {
    if (!languageDrafts.has(row.id)) languageDrafts.set(row.id, { selected: '', needsPreview: false, revision: 0 })
    return languageDrafts.get(row.id)
  }

  function updateCard(card, row) {
    card.row = row
    const pinned = snapshot.pinnedRowIds.includes(row.id)
    const pending = client.isPending(row.id)
    const ownRecording = voiceSession?.rowId === row.id
    const disabled = !client.isConnected() || pending || !snapshot.collecting || ownRecording
    const tierName = row.triage?.tier ?? 'neutral'
    card.node.className = `message-card tier-${Object.hasOwn(tierLabels, tierName) ? tierName : 'neutral'}${pinned ? ' is-pinned' : ''}`
    card.name.textContent = row.nickname || '未提供昵称'
    card.avatar.textContent = Array.from(row.nickname || '?')[0]
    card.handle.textContent = row.mentionHandle ? `@${row.mentionHandle.replace(/^@/, '')}` : ''
    card.handle.hidden = !row.mentionHandle
    card.time.textContent = formatTime(row.receivedAt)
    card.tier.textContent = row.triage?.label || tierLabels[tierName] || '普通'
    const color = row.triage?.cardColor || snapshot.audienceRules?.find(rule => rule.id === row.triage?.matchedRuleId)?.color
    card.node.style.setProperty('--rule-color', /^#[0-9a-f]{6}$/i.test(color ?? '') ? color : tierName === 'gold' ? '#bf8f38' : tierName === 'silver' ? '#7e91aa' : '#b4c7c6')
    card.fact.textContent = factText(row)
    card.pinTag.hidden = !pinned
    card.original.textContent = row.original || factText(row)
    const translation = row.translation ?? {}
    const visible = translation.status === 'pending' && translation.fallback ? { ...translation.fallback, status: 'ready' } : translation
    const unknown = translation.status === 'skipped' && translation.language === 'und'
    card.translation.textContent = visible.status === 'ready' ? visible.chinese || '' : ''
    card.translation.hidden = !card.translation.textContent
    card.translationNote.textContent = retranslationInFlight.has(row.id) ? 'DeepSeek 复译中，原译文保留'
      : translation.manualAttempt ? translation.manualAttempt.status === 'skipped' ? '含义不明确，保留本地译文' : translation.manualAttempt.message
        : unknown ? '含义不明确，保留原文' : translation.status === 'pending' ? translation.source === 'local' ? 'Chrome 本地翻译中' : 'DeepSeek 复译中，原译文保留'
          : translation.error || (visible.status === 'ready' ? visible.source === 'local' ? visible.method === 'dictionary' ? '本地词表' : 'Chrome 本地译文' : visible.source === 'browser' ? '网页译文' : 'AI 译文' : '')
    card.translationNote.hidden = !card.translationNote.textContent
    card.translationNote.classList.toggle('reply-error', translation.status === 'failed' || ['failed', 'interrupted'].includes(translation.manualAttempt?.status))
    card.retranslate.hidden = row.kind !== 'comment' || ['sent', 'dismissed'].includes(row.reply?.status) || translation.status === 'ready' && translation.source === 'ai'
    card.retranslate.disabled = disabled || snapshot.ai?.paused || snapshot.ai?.used >= snapshot.ai?.limit || translation.status === 'pending' || busyReplies.has(row.reply?.status)
    card.retranslate.textContent = retranslationInFlight.has(row.id) || translation.status === 'pending' && translation.source === 'ai' ? 'DeepSeek 复译中…' : 'DeepSeek 复译'
    const facts = []
    if (Number.isFinite(row.payLevel)) facts.push(`消费 Lv.${row.payLevel}`)
    if (Number.isFinite(row.fansClubLevel)) facts.push(`粉丝团 Lv.${row.fansClubLevel}`)
    if (Number.isFinite(row.followerCount)) facts.push(`粉丝 ${row.followerCount.toLocaleString('zh-CN')}`)
    card.viewerFacts.textContent = facts.join(' · ')
    card.viewerFacts.hidden = !facts.length
    card.pin.textContent = pending ? '提交中…' : pinned ? '取消钉住' : '钉住'
    card.pin.setAttribute('aria-pressed', String(pinned))
    card.pin.disabled = disabled || ['sent', 'dismissed'].includes(row.reply?.status)
    card.defer.disabled = disabled || row.reply?.status === 'sending'
    card.complete.disabled = disabled || busyReplies.has(row.reply?.status)
    const replyLabels = { queued: '回复排队中', generating: '回复生成中', sending: '正在发送', sent: '已发送', failed: '发送失败', interrupted: '回复已中断', dismissed: '已完成' }
    card.replyStatus.textContent = replyLabels[row.reply?.status] ?? ''
    card.replyStatus.hidden = !card.replyStatus.textContent
    card.replyStatus.classList.toggle('reply-error', ['failed', 'interrupted'].includes(row.reply?.status))
    const showDraft = card.mode === 'tasks' && ['review', 'none', 'interrupted', 'failed'].includes(row.reply?.status)
    card.draftBox.hidden = !showDraft
    if (showDraft) {
      const draft = syncDraft(drafts.get(row.id), row)
      const chinese = chineseDraftFor(row)
      const language = languageDraftFor(row)
      const languageChanged = language.needsPreview || Boolean(row.reply.text && replyTargetLanguage(row, language) !== languageCode(row.reply.targetLanguage))
      drafts.set(row.id, draft)
      if (card.textarea.value !== draft.text) card.textarea.value = draft.text
      card.textarea.disabled = disabled
      if (card.chineseInput.value !== chinese.text) card.chineseInput.value = chinese.text
      card.chineseInput.disabled = !client.isConnected() || !snapshot.collecting
      card.clearChinese.disabled = disabled || !chinese.text || row.reply.draftTranslation?.status === 'pending'
      card.languagePicker.value = language.selected
      card.languagePicker.disabled = !client.isConnected() || !snapshot.collecting || pending
      const knownLanguage = languageCode(row.kind === 'comment' ? row.translation?.language : row.reply.targetLanguage ?? row.translation?.language)
      const automaticLanguage = automaticReplyLanguage(row)
      const languageSource = row.replyLanguageHint?.source || (knownLanguage ? 'observed' : 'default-english')
      const sourceLabel = { manual: '人工选择', observed: '按发言', 'recent-viewer-comment': '参考同场发言', 'nickname-hint': '参考昵称·推测', 'default-english': '默认英语' }[languageSource] || '回复建议'
      const automaticLabel = replyLanguages.find(([code]) => code === automaticLanguage)?.[1] || automaticLanguage
      const selectedLabel = replyLanguages.find(([code]) => code === language.selected)?.[1] || language.selected
      card.languagePicker.options[0].textContent = `自动 · ${automaticLabel}（${sourceLabel}）`
      card.languageHint.textContent = languageChanged ? '回复语言已修改，请重新翻译并核对预览' : language.selected ? `手动回复语言：${selectedLabel}` : `${sourceLabel}：${automaticLabel} · 仅用于回复草稿`
      card.record.textContent = ownRecording ? '结束录音并获取文字' : '使用电脑麦克风'
      card.record.disabled = !client.isConnected() || !snapshot.collecting || pending || Boolean(voiceSession && (!ownRecording || voiceSession.phase !== 'recording'))
      card.cancelRecord.hidden = !ownRecording
      card.cancelRecord.disabled = !client.isConnected() || ownRecording && (voiceSession.phase === 'cancelling' || voiceSession.cancelRequested && client.isPending(row.id))
      card.voiceNote.textContent = chinese.conflict ? '电脑端中文草稿已改变，已保留你的编辑；翻译时将使用当前内容。' : '使用服务电脑的麦克风，识别后仅填入中文草稿。'
      const retainedTranscript = transcripts.get(row.id)
      card.transcript.textContent = retainedTranscript ? `识别文字：${retainedTranscript}` : ''
      card.transcript.hidden = !retainedTranscript
      card.appendTranscript.hidden = !retainedTranscript
      card.appendTranscript.disabled = !client.isConnected() || !snapshot.collecting || Boolean(voiceSession)
      card.translate.textContent = pending && !ownRecording ? '正在更新预览…' : '翻译并更新预览'
      card.translate.disabled = disabled || Boolean(voiceSession) || !chinese.text.trim() || row.reply.draftTranslation?.status === 'pending' || !languageChanged && !chinese.needsPreview && chinese.text === (row.reply.chinese ?? '') && Boolean(row.reply.text) && row.reply.draftTranslation?.status !== 'failed'
      card.sendingGroup.hidden = row.reply.status !== 'review' && !row.reply.text
      card.draftHint.textContent = languageChanged ? '回复语言已修改，请重新翻译并核对预览' : chinese.needsPreview || chinese.text !== (row.reply.chinese ?? '') ? '中文草稿已修改，请先翻译并更新预览' : row.reply.draftTranslation?.status === 'pending' ? '正在翻译中文草稿，请等待预览更新' : row.reply.draftTranslation?.status === 'failed' ? '中文翻译失败，请重新更新预览' : draft.conflict ? '电脑端草稿已更新，已保留你的编辑；保存将覆盖当前草稿。' : draft.text !== row.reply.text ? '有未保存修改，请先保存草稿' : '确认后会立即发送此回复'
      card.draftHint.classList.toggle('conflict', draft.conflict)
      card.save.disabled = disabled || !draft.text.trim() || draft.text === row.reply.text
      card.approve.disabled = disabled || !canApprove(row, draft, chinese, language)
    }
  }

  function renderCards() {
    if (!snapshot) return
    for (const mode of ['live', 'tasks']) {
      const scrollView = viewports[mode]
      const viewportTop = scrollView.getBoundingClientRect().top
      const anchor = panes[mode].hidden ? null : [...lists[mode].children].find(node => node.getBoundingClientRect().bottom > viewportTop)
      const anchorOffset = anchor ? anchor.getBoundingClientRect().top : 0
      const beforeScroll = scrollView.scrollTop
      const rows = visibleRows(snapshot, mode, filter)
      const ids = new Set(rows.map(row => row.id))
      for (const [id, card] of cards[mode]) {
        if (!ids.has(id)) { card.node.remove(); cards[mode].delete(id) }
      }
      let index = 0
      for (const row of rows) {
        let card = cards[mode].get(row.id)
        if (!card) { card = createCard(row, mode); cards[mode].set(row.id, card) }
        updateCard(card, row)
        if (lists[mode].children[index] !== card.node) lists[mode].insertBefore(card.node, lists[mode].children[index] || null)
        index++
      }
      // Each pane retains its own reading anchor, including while the other is touched.
      if (anchor?.isConnected && anchor.closest('.card-list') === lists[mode]) {
        const delta = anchor.getBoundingClientRect().top - anchorOffset
        if (Math.abs(delta) > 0.5) {
          autoScrollUntil[mode] = performance.now() + 100
          scrollView.scrollTop = beforeScroll + delta
        }
      }
      const all = mode === 'tasks' ? snapshot.tasks : snapshot.rows
      countTexts[mode].textContent = `${rows.length} 条${mode === 'tasks' && snapshot.totalTasks > all.length ? ` · 共 ${snapshot.totalTasks} 待办` : ''}`
      empties[mode].hidden = rows.length > 0
      empties[mode].querySelector('h3').textContent = all.length ? '暂无符合筛选的内容' : mode === 'tasks' ? '暂时没有待办任务' : '等待新的直播消息'
      empties[mode].querySelector('p').textContent = all.length ? '可以调整客户筛选，查看其他消息' : (snapshot.captureActive ?? snapshot.collecting) ? snapshot.captureStatus === 'storage-error' ? '采集仍在进行，保存异常，请在电脑端检查' : mode === 'tasks' ? '需要处理的消息会出现在这里' : '新的评论、礼物与互动会显示在这里' : '请在电脑端开始采集'
    }
  }

  function render() {
    renderStatus()
    const selectionCount = (filter.events?.length || 0) + (filter.tiers?.length || 0) + ['minPayLevel', 'minFansClubLevel', 'minFollowers'].filter(key => filter[key] !== '' && filter[key] != null).length
    filterButton.textContent = selectionCount ? `筛选 · ${selectionCount}` : '筛选'
    filterButton.classList.toggle('has-filter', selectionCount > 0)
    for (const mode of ['live', 'tasks']) filterSummaries[mode].textContent = selectionCount ? `已启用 ${selectionCount} 项筛选 · 仅本机显示` : '全部客户 · 本机筛选'
    renderCards()
  }

  async function runRowAction(card, action) {
    const row = card.row
    if (client.isPending(row.id)) return
    const draft = drafts.get(row.id)
    const chinese = chineseDraftFor(row)
    const language = languageDraftFor(row)
    const submittedLanguage = language.selected
    const submittedLanguageRevision = language.revision
    let command
    try {
      const retryKey = `${row.id}:${action}`
      if (voiceSession?.rowId === row.id) throw Error('请先结束或取消当前录音')
      if (action === 'defer' || action === 'approve' || action === 'translate') {
        // A failed transport can be retried explicitly with the same intent ID.
        // A changed draft represents a different intent.
        const intent = action === 'approve' ? JSON.stringify([draft?.text, language.selected]) : action === 'translate' ? JSON.stringify([chinese.text, language.selected, replyTargetLanguage(row, language)]) : ''
        const previous = retryIds.get(retryKey)
        if (!previous || previous.intent !== intent) retryIds.set(retryKey, { id: requestId(), intent })
      }
      command = rowCommand(action, row, { pinned: snapshot.pinnedRowIds.includes(row.id), text: draft?.text, chinese: chinese.text, targetLanguage: submittedLanguage, requestId: retryIds.get(retryKey)?.id })
      if (action === 'retranslate') { retranslationInFlight.add(row.id); renderCards() }
      if (action === 'approve' && !canApprove(row, draft, chinese, language)) throw Error('请先更新并核对发送预览，再确认发送')
      const result = await client.command(command.action, command.params, row.id)
      if (result.ok) {
        if (action === 'retranslate' && snapshot.accountId === row.accountId && snapshot.sessionId === row.sessionId && result.data?.id === row.id && result.data.accountId === row.accountId && result.data.sessionId === row.sessionId && result.data.original === row.original) {
          for (const key of ['rows', 'tasks']) snapshot[key] = snapshot[key].map(value => value.id === row.id && value.original === row.original ? result.data : value)
        }
        if (action === 'translate' && chineseDrafts.get(row.id)?.text === command.params.chinese) chineseDrafts.get(row.id).needsPreview = false
        if (action === 'translate' && language.revision === submittedLanguageRevision && language.selected === submittedLanguage &&
          (!submittedLanguage || languageCode(result.data?.reply?.targetLanguage) === submittedLanguage)) language.needsPreview = false
        retryIds.delete(retryKey)
        showNotice(action === 'retranslate' ? result.data?.translation?.manualAttempt?.message || (result.data?.translation?.language === 'und' ? '含义不明确，保留原文' : 'DeepSeek 复译已更新') : action === 'approve' ? '发送操作已确认' : action === 'translate' ? '翻译已完成，请核对预览后确认发送' : action === 'save' ? '草稿已保存，正在核对最新状态' : action === 'complete' ? '任务已完成' : action === 'defer' ? '已稍后处理' : '钉住状态已更新', false)
        // Do not mark a changed draft as saved while its save request was pending.
        if (action === 'save' && drafts.get(row.id)?.text === command.params.text) {
          const saved = result.data?.reply?.text
          if (saved === command.params.text) drafts.set(row.id, { text: saved, baseText: saved, conflict: false })
        }
      } else if (result.error.code !== 'OFFLINE') {
        if (action === 'translate') retryIds.delete(retryKey)
        showNotice(replyErrorMessages[result.error.code] || result.error.message)
      }
      await refresh()
    } catch (error) { showNotice(error.message) }
    finally { retranslationInFlight.delete(row.id); renderCards() }
  }

  async function startVoice(card) {
    if (voiceSession || !client.isConnected() || client.isPending(card.row.id)) return
    const row = card.row
    const session = { rowId: row.id, accountId: snapshot.accountId, sessionId: snapshot.sessionId, nickname: row.nickname || '当前观众', baseline: chineseDraftFor(row).text, phase: 'starting', cancelRequested: false }
    voiceSession = session; render()
    const result = await client.voice('start', row.id)
    if (voiceSession !== session) return
    if (result.ok && result.data.rowId === row.id && result.data.status === 'recording') session.phase = 'recording'
    else {
      if (!result.ok && ['VOICE_INVALID_COMMAND', 'VOICE_BUSY', 'VOICE_SERVICE_BUSY', 'VOICE_ALREADY_RECORDING', 'VOICE_NOT_OWNED', 'VOICE_NO_ACTIVE_SESSION', 'VOICE_ROW_NOT_FOUND', 'VOICE_MIC_BLOCKED', 'VOICE_START_NOT_STARTED'].includes(result.error.code)) voiceSession = null
      else session.phase = 'uncertain'
      showNotice(result.ok ? '录音状态未确认，请取消后重试' : result.error.message)
    }
    render()
    if (leaving || session.cancelRequested) await cancelVoice()
  }

  async function stopVoice() {
    const session = voiceSession
    if (!session || session.phase !== 'recording' || client.isPending(session.rowId) || !client.isConnected()) return
    session.phase = 'stopping'; render()
    const result = await client.voice('stop', session.rowId)
    if (voiceSession !== session) return
    if (result.ok && result.data.status === 'stopped' && result.data.rowId === session.rowId) {
      const row = snapshot.tasks.find(row => row.id === session.rowId && row.sessionId === session.sessionId)
      const valid = !leaving && !session.cancelRequested && snapshot.accountId === session.accountId && snapshot.sessionId === session.sessionId && snapshot.collecting && row && !['sent', 'dismissed'].includes(row.reply.status)
      const text = typeof result.data.text === 'string' ? result.data.text.trim() : ''
      if (valid && text && text.length <= 1000) {
        const draft = chineseDraftFor(row)
        if (draft.text === session.baseline) {
          chineseDrafts.set(row.id, { ...draft, text })
          showNotice(result.data.micWarning ? `识别文字已填入中文草稿；${result.data.micWarning}` : '识别文字已填入中文草稿，请检查内容', !!result.data.micWarning)
        } else {
          transcripts.set(row.id, text)
          showNotice('已保留你的修改，可手动追加识别文字', false)
        }
      } else if (!leaving) showNotice(session.cancelRequested ? '识别结果已丢弃，中文草稿保留' : '任务或场次已变化，识别文字未填入其他观众草稿', session.cancelRequested ? false : true)
      voiceSession = null
    } else {
      session.phase = 'uncertain'
      showNotice(result.ok ? '录音结果未确认，请取消后重试' : result.error.message)
    }
    render()
    if (!leaving) await runMic('status')
    if (voiceSession === session && (leaving || session.cancelRequested)) await cancelVoice()
    await refresh()
  }

  async function cancelVoice() {
    const session = voiceSession
    if (!session) return
    if (client.isPending(session.rowId)) {
      session.cancelRequested = true
      if (!leaving) showNotice('已请求取消，当前操作结束后将丢弃识别结果', false)
      render()
      return
    }
    if (!client.isConnected()) return
    session.cancelRequested = false
    session.phase = 'cancelling'; render()
    const result = await client.voice('cancel', session.rowId, { keepalive: leaving })
    if (voiceSession !== session) return
    if (result.ok && result.data.status === 'cancelled' && result.data.rowId === session.rowId || !result.ok && result.error.code === 'VOICE_NOT_OWNED') {
      voiceSession = null
      if (!leaving) showNotice(result.ok && result.data.micWarning ? result.data.micWarning : '录音已取消，中文草稿保留', result.ok && !!result.data.micWarning)
    } else {
      session.phase = 'uncertain'
      showNotice(result.ok ? '取消录音尚未确认，请重试' : result.error.message)
    }
    render()
    if (!leaving) await runMic('status')
  }
  window.addEventListener('pagehide', () => {
    leaving = true
    clearXiaomiFocus(); cancelZoom()
    if (voiceSession) { voiceSession.cancelRequested = true; void cancelVoice() }
  })
  window.addEventListener('pageshow', () => { leaving = false })

  markerButton.addEventListener('click', async () => {
    if (markerButton.disabled || Date.now() < markerNotBefore || !snapshot?.collecting || !snapshot.sessionId) return
    try {
      // Keep a very fast acknowledgement from turning an accidental double tap into start + end.
      markerNotBefore = Date.now() + 600
      // An explicit retry reuses the original intent; a timeout must never become a second toggle.
      if (!markerIntent) markerIntent = {
        accountId: snapshot.accountId, sessionId: snapshot.sessionId,
        expectedOpenSegmentId: snapshot.marker?.open?.id ?? null, requestId: requestId(), phase: 'pending',
      }
      const intent = markerIntent
      intent.phase = 'pending'; renderMarker()
      const result = await client.command('segment-toggle', {
        requestId: intent.requestId, sessionId: intent.sessionId, expectedOpenSegmentId: intent.expectedOpenSegmentId,
      }, 'segment-toggle')
      if (markerIntent !== intent) return
      if (result.ok) {
        intent.phase = 'confirmed'
        showNotice('打点操作已确认，正在核对当前片段', false)
      } else if (['SEGMENT_CHANGED', 'MOBILE_SESSION_CHANGED', 'NO_ACTIVE_SESSION', 'INVALID_REQUEST', 'UNSUPPORTED'].includes(result.error.code)) {
        markerIntent = null
        showNotice(result.error.message)
      } else {
        intent.phase = 'uncertain'
        showNotice(result.error.message)
      }
      renderMarker()
      await refresh()
    } catch (error) {
      if (markerIntent) markerIntent.phase = 'uncertain'
      showNotice(error.message); renderMarker()
    }
  })

  countdownButton.addEventListener('click', async () => {
    const state = countdownState(snapshot, receivedAt, Date.now())
    if (!state || countdownButton.disabled) return
    const result = await client.command('attention-countdown', { windowId: state.windowId, paused: !state.paused }, state.windowId)
    if (result.ok) showNotice('清理设置已提交，正在核对当前批次', false)
    else showNotice(result.error.message)
    await refresh()
  })
  let refreshTimer
  async function refresh() {
    clearTimeout(refreshTimer)
    if (document.hidden) { refreshTimer = setTimeout(refresh, 10_000); return }
    await client.poll()
    refreshTimer = setTimeout(refresh, 2000)
  }
  retryButton.addEventListener('click', () => void refresh())
  document.addEventListener('visibilitychange', () => {
    for (const mode of ['live', 'tasks']) follows[mode].pointerEnd(performance.now())
    if (!document.hidden) void refresh()
  })
  window.addEventListener('online', () => void refresh())
  window.addEventListener('offline', () => client.disconnect())

  function updateLayout() {
    wide = wideMedia.matches
    shell.classList.toggle('wide', wide)
    for (const mode of ['live', 'tasks']) panes[mode].hidden = !wide && mode !== tab
    liveTab.classList.toggle('active', tab === 'live'); taskTab.classList.toggle('active', tab === 'tasks')
    liveTab.setAttribute('aria-current', tab === 'live' ? 'page' : 'false'); taskTab.setAttribute('aria-current', tab === 'tasks' ? 'page' : 'false')
  }
  wideMedia.addEventListener('change', () => { updateLayout(); render() })
  updateLayout()
  function setTab(value) {
    if (tab === value) return
    tab = value
    updateLayout()
    render()
  }
  liveTab.addEventListener('click', () => setTab('live'))
  taskTab.addEventListener('click', () => setTab('tasks'))
  const pointerOwners = new Map()
  function endTouch(event) {
    const mode = pointerOwners.get(event.pointerId)
    if (mode) { follows[mode].pointerEnd(performance.now()); pointerOwners.delete(event.pointerId) }
  }
  window.addEventListener('pointerup', endTouch, { passive: true })
  window.addEventListener('pointercancel', endTouch, { passive: true })
  for (const mode of ['live', 'tasks']) {
    speedInputs[mode].addEventListener('change', () => {
      const value = Number(speedInputs[mode].value)
      if (!followSpeeds.includes(value)) return
      followRates[mode] = value
      scrollRemainder[mode] = 0
      if (loadedAccount) { try { localStorage.setItem(`oba-mobile-follow:${loadedAccount}`, JSON.stringify(followRates)) } catch {} }
    })
    const scrollView = viewports[mode]
    const follow = follows[mode]
    const updateButton = () => {
      followButtons[mode].textContent = follow.isManual() ? '▶ 继续跟随' : 'Ⅱ 暂停跟随'
      followButtons[mode].setAttribute('aria-pressed', String(follow.isManual()))
    }
    followButtons[mode].addEventListener('click', () => { follow.setManual(!follow.isManual()); updateButton() })
    latestButtons[mode].addEventListener('click', () => {
      follow.setManual(false); updateButton()
      autoScrollUntil[mode] = performance.now() + 100
      scrollView.scrollTop = scrollView.scrollHeight
    })
    scrollView.addEventListener('pointerdown', event => { pointerOwners.set(event.pointerId, mode); follow.pointerDown(performance.now()) }, { passive: true })
    scrollView.addEventListener('lostpointercapture', endTouch, { passive: true })
    scrollView.addEventListener('scroll', () => { if (performance.now() > autoScrollUntil[mode]) follow.scrolled(performance.now()) }, { passive: true })
    scrollView.addEventListener('wheel', () => follow.scrolled(performance.now()), { passive: true })
    scrollView.addEventListener('focusin', () => follow.setFocused(true))
    scrollView.addEventListener('focusout', () => queueMicrotask(() => follow.setFocused(scrollView.contains(document.activeElement))))
  }

  let previouslyFocused
  function closeFilters() {
    sheetOpen = false; overlay.hidden = true; shell.inert = false
    previouslyFocused?.focus({ preventScroll: true })
  }
  function fillFilters(value) {
    for (const [key, input] of eventInputs) input.checked = Boolean(value.events?.includes(key))
    for (const [key, input] of tierInputs) input.checked = Boolean(value.tiers?.includes(key))
    for (const [key, input] of numericInputs) input.value = value[key] ?? ''
  }
  filterButton.addEventListener('click', () => {
    previouslyFocused = document.activeElement
    filterDraft = { ...filter }
    fillFilters(filterDraft)
    sheetOpen = true; overlay.hidden = false; shell.inert = true
    closeSheet.focus({ preventScroll: true })
  })
  closeSheet.addEventListener('click', closeFilters)
  overlay.addEventListener('click', event => { if (event.target === overlay) closeFilters() })
  overlay.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeFilters()
    if (event.key === 'Tab') {
      const items = [...sheet.querySelectorAll('button,input')].filter(node => !node.disabled)
      const first = items[0], last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { last.focus(); event.preventDefault() }
      else if (!event.shiftKey && document.activeElement === last) { first.focus(); event.preventDefault() }
    }
  })
  resetFilters.addEventListener('click', () => { filterDraft = {}; fillFilters(filterDraft) })
  filterForm.addEventListener('submit', event => {
    event.preventDefault()
    const value = {
      events: [...eventInputs].filter(([, input]) => input.checked).map(([key]) => key),
      tiers: [...tierInputs].filter(([, input]) => input.checked).map(([key]) => key),
    }
    for (const [key, input] of numericInputs) if (input.value !== '') value[key] = Math.max(0, Math.trunc(Number(input.value)))
    filter = value
    if (loadedAccount) { try { localStorage.setItem(`oba-mobile-filter:${loadedAccount}`, JSON.stringify(filter)) } catch {} }
    closeFilters(); render()
  })

  let countdownTick = 0
  function frame(now) {
    const elapsed = Math.min(50, Math.max(0, now - (lastFrame || now)))
    lastFrame = now
    for (const mode of ['live', 'tasks']) {
      const scrollView = viewports[mode]
      if (!document.hidden && !sheetOpen && !voiceSession && !panes[mode].hidden && follows[mode].canFollow(now) && !scrollView.contains(document.activeElement)) {
        const max = Math.max(0, scrollView.scrollHeight - scrollView.clientHeight)
        if (scrollView.scrollTop < max) {
          autoScrollUntil[mode] = now + 100
          scrollRemainder[mode] += elapsed * followRates[mode] / 1000
          const pixels = Math.floor(scrollRemainder[mode])
          scrollRemainder[mode] -= pixels
          if (pixels) scrollView.scrollTop = Math.min(max, scrollView.scrollTop + pixels)
        }
      } else scrollRemainder[mode] = 0
    }
    if (now - countdownTick > 500) { countdownTick = now; renderCountdown(); renderMarker() }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  void refresh()
}

if (typeof document !== 'undefined') mountMobileDesk()
