function initialState() {
  return { phase: 'connecting', transport: false, microphone: null, demand: null, denied: false }
}

function phase(state) {
  if (state.denied) return 'denied'
  if (!state.transport) return 'disconnected'
  if (state.microphone === true) return 'forwarding'
  if (state.microphone === false && state.demand !== null) return state.demand ? 'idle' : 'inactive'
  return 'awaiting-ack'
}

function transition(state, event) {
  if (state.phase === 'quit') return state
  if (event.type === 'quit') return { ...initialState(), phase: 'quit' }
  if (state.phase === 'paused' && event.type !== 'resume') return state
  if (event.type === 'pause') return { ...initialState(), phase: 'paused' }
  if (event.type === 'resume' || event.type === 'reset') return initialState()
  let next = { ...state }
  if (event.type === 'transport') {
    next.transport = event.open === true
    if (!next.transport) { next.microphone = null; next.demand = null }
  } else if (event.type === 'microphone' && typeof event.active === 'boolean') next.microphone = event.active
  else if (event.type === 'demand' && typeof event.enabled === 'boolean') next.demand = event.enabled
  else if (event.type === 'denied') next.denied = true
  else return state
  next.phase = phase(next)
  return next
}

function statusLabel(state) {
  return {
    connecting: '正在连接本机语音服务',
    disconnected: '语音连接已断开 · 等待重连',
    'awaiting-ack': '已连接 · 等待麦克风状态确认',
    inactive: '已连接 · 麦克风未开启（请检查权限或设备）',
    idle: '已连接 · 等待录音（麦克风已释放）',
    forwarding: '正在转发麦克风到语音容器',
    denied: '麦克风权限被拒绝 · 请在系统设置中允许',
    paused: '连接已暂停 · 麦克风已释放',
    quit: '语音连接已结束',
  }[state.phase] || '状态未知'
}

module.exports = { initialState, transition, statusLabel }
