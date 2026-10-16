const { contextBridge, ipcRenderer } = require('electron')

// No API or Node object is exposed to the remote desktop. Only status booleans
// leave this renderer; audio, page contents, credentials and clipboard do not.
if (process.isMainFrame && window.location.origin === 'https://127.0.0.1:13443') {
  const origin = window.location.origin
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== origin || !event.data || typeof event.data !== 'object') return
    const message = event.data
    let observation
    if (message.type === 'serverSettings' && message.payload && typeof message.payload === 'object') {
      observation = { type: 'settings', demand: message.payload.microphone_on_demand?.value === true }
    } else if (['sidebarButtonStatusUpdate', 'pipelineStatusUpdate'].includes(message.type) && typeof message.microphone === 'boolean') {
      observation = { type: 'microphone', active: message.microphone }
    } else if (message.type === 'stats' && typeof message.data?.isMicrophoneActive === 'boolean') {
      observation = { type: 'microphone', active: message.data.isMicrophoneActive }
    } else if (message.type === 'obaVoiceTransport' && typeof message.open === 'boolean') {
      observation = { type: 'transport', open: message.open }
    }
    if (observation) ipcRenderer.send('oba-voice-observation', observation)
  })

  ipcRenderer.on('oba-voice-enable', () => {
    window.postMessage({ type: 'pipelineControl', pipeline: 'microphone', enabled: true }, origin)
  })

  // These controls belong to the Mac companion, not the browser pictured in
  // the remote video. They never send input or commands to that browser.
  function installWindowControls() {
    const host = document.createElement('div')
    host.id = 'oba-voice-native-controls'
    const shadow = host.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = `
      :host { all: initial; position: fixed !important; z-index: 2147483647 !important;
        top: 10px !important; right: 12px !important; display: block !important;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif; color: #fff; }
      .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
        max-width: calc(100vw - 48px); padding: 10px 12px; border: 1px solid #747d9a;
        border-radius: 12px; background: #182039; box-shadow: 0 3px 16px #0008; }
      .label { font-size: 12px; font-weight: 600; color: #cdd7ef; }
      button { cursor: pointer; padding: 8px 12px; border-radius: 7px; border: 1px solid #9ab1f5;
        background: #e8efff; color: #11234e; font-size: 14px; font-weight: 700; }
      button:hover { background: #fff; }
      button:focus-visible { outline: 3px solid #8acbff; outline-offset: 2px; }
      .hint { flex-basis: 100%; color: #b9efce; font-size: 12px; text-align: right; }
    `
    const toolbar = document.createElement('div')
    toolbar.className = 'bar'
    toolbar.setAttribute('role', 'toolbar')
    toolbar.setAttribute('aria-label', 'OBA Voice 本机窗口控制')
    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = 'OBA Voice · 本机窗口'
    toolbar.append(label)
    for (const [action, text] of [['minimize', '最小化'], ['hide', '收起到后台']]) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = text
      button.setAttribute('aria-label', text)
      button.addEventListener('click', event => {
        event.preventDefault()
        event.stopPropagation()
        if (event.isTrusted && (action === 'minimize' || action === 'hide')) {
          ipcRenderer.send('oba-voice-window-action', action)
        }
      })
      toolbar.append(button)
    }
    const hint = document.createElement('span')
    hint.className = 'hint'
    hint.textContent = '收起后豆包继续运行'
    toolbar.append(hint)
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'wheel', 'keydown', 'keyup']) {
      toolbar.addEventListener(type, event => event.stopPropagation())
    }
    shadow.append(style, toolbar)
    document.documentElement.append(host)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installWindowControls, { once: true })
  else installWindowControls()

  // The old supported Selkies client does not expose its transport object.
  // Observe real WebSocket lifecycle before page scripts run; never read data.
  contextBridge.executeInMainWorld({ func: () => {
    const NativeWebSocket = window.WebSocket
    const openSockets = new Set()
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args)
        let url
        try { url = new URL(args[0]) } catch { return }
        if (url.origin !== 'wss://127.0.0.1:13443' || !url.pathname.endsWith('/websockets')) return
        this.addEventListener('open', () => {
          openSockets.add(this)
          window.postMessage({ type: 'obaVoiceTransport', open: true }, window.location.origin)
        })
        const closed = () => {
          openSockets.delete(this)
          window.postMessage({ type: 'obaVoiceTransport', open: openSockets.size > 0 }, window.location.origin)
        }
        this.addEventListener('close', closed)
        this.addEventListener('error', closed)
      }
    }
  } })
}
