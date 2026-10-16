const path = require('node:path')
const { X509Certificate } = require('node:crypto')
const { START_URL, isAllowedNavigation, isAllowedRequest, canAccessAudio, isPinnedCertificate,
  canControlWindow, certificateVerificationResult } = require('./policy.cjs')
const { loadTrust, saveTrust, privateDirectory } = require('./trust.cjs')
const { VoiceConnection } = require('./connection.cjs')
const { MicrophoneGate } = require('./protocol.cjs')
const { statusLabel } = require('./state.cjs')
const { isSyntheticAudioSession } = require('./synthetic.cjs')

async function main() {
  const { app, BrowserWindow, Menu, Tray, nativeImage, session, ipcMain, systemPreferences, dialog } = require('electron')
  app.setName('OBA Voice')
  const override = process.argv.find(value => value.startsWith('--voice-user-data='))
  const productionUserData = path.join(app.getPath('appData'), 'OBA-Voice')
  const userData = override ? override.slice('--voice-user-data='.length) : productionUserData
  privateDirectory(userData)
  const syntheticAudio = isSyntheticAudioSession({ args: process.argv, userData, productionUserData })
  app.setPath('userData', userData)
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-background-timer-throttling')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  if (!app.requestSingleInstanceLock()) { app.quit(); return }
  // Prevent any outer URL/open-file event from changing this app's destination.
  app.on('open-url', event => event.preventDefault())
  app.on('open-file', event => event.preventDefault())

  let pin
  try { pin = loadTrust(userData, process.argv) }
  catch (error) {
    await app.whenReady()
    dialog.showErrorBox('OBA Voice 本机证书配置错误', error.message)
    app.quit()
    return
  }
  if (!pin) {
    await app.whenReady()
    dialog.showErrorBox('OBA Voice 尚未配置信任证书',
      '请使用安装时核对过的本机容器公钥证书配置 server-cert.pem，或用 --certificate=/绝对路径/cert.pem 启动一次。不会自动信任网络返回的证书。')
    app.quit()
    return
  }
  saveTrust(userData, pin)
  await app.whenReady()

  const voiceSession = session.fromPartition('persist:oba-voice', { cache: true })
  let connection
  let tray
  let retryTimer
  let retryDelay = 1000
  let microphonePrompt
  let nativeQuitting = false

  function clearRetry() { if (retryTimer) clearTimeout(retryTimer); retryTimer = undefined }
  function activeWindow() { return connection?.window && !connection.window.isDestroyed() ? connection.window : null }
  function trustedContents(contents) { return contents && activeWindow()?.webContents === contents && isAllowedNavigation(contents.getURL()) }
  function drawState(state) {
    const status = statusLabel(state)
    const window = activeWindow()
    if (window) window.setTitle(`OBA Voice · ${status}`)
    const paused = state.phase === 'paused'
    const items = [
      { label: status, enabled: false },
      { label: '显示语音窗口', enabled: !paused, click: () => connection.show() },
      { label: '最小化', enabled: !paused, click: () => connection.performWindowAction('minimize') },
      { label: '收起到后台（豆包继续运行）', enabled: !paused, click: () => connection.performWindowAction('hide') },
      { label: paused ? '恢复语音连接' : '暂停语音连接并释放麦克风', click: () => {
        clearRetry()
        if (paused) connection.resume()
        else connection.pause()
      } },
      { label: '重新连接', enabled: !paused, click: () => {
        clearRetry()
        connection.pause()
        retryDelay = 1000
        connection.resume()
      } },
      { type: 'separator' },
      { label: '退出 OBA Voice', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
    ]
    const menu = Menu.buildFromTemplate(items)
    tray?.setContextMenu(menu)
    tray?.setToolTip(`OBA Voice · ${status}`)
    tray?.setTitle(state.phase === 'forwarding' ? '语音 ●' : paused ? '语音 ‖' : '语音')
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'OBA Voice', submenu: items },
      { label: '编辑', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }] }]))
  }

  function scheduleRetry(window) {
    if (retryTimer || activeWindow() !== window || ['paused', 'quit'].includes(connection.state.phase)) return
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      if (activeWindow() !== window) return
      connection.update({ type: 'reset' })
      window.loadURL(START_URL).catch(() => scheduleRetry(window))
    }, retryDelay)
    retryDelay = Math.min(retryDelay * 2, 30000)
  }

  // A certificate exception is accepted only for this WebContents and URL.
  // No process-wide ignore-certificate-errors flag or hostname-only bypass.
  app.on('certificate-error', (event, contents, url, _error, certificate, callback) => {
    let fingerprint
    try { fingerprint = new X509Certificate(certificate.data).fingerprint256 } catch { callback(false); return }
    if (activeWindow()?.webContents === contents && isPinnedCertificate({ url, fingerprint, expectedFingerprint: pin })) {
      event.preventDefault()
      callback(true)
    } else callback(false)
  })

  voiceSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedRequest(details.url) })
  })
  // Chromium's normal trusted-CA path must also satisfy the pinned certificate.
  // verifyProc exposes a hostname, not a port; onBeforeRequest above independently
  // restricts every HTTPS/WSS request to the exact loopback origin and port.
  voiceSession.setCertificateVerifyProc((request, callback) => {
    callback(certificateVerificationResult(request, pin))
  })
  voiceSession.on('will-download', event => event.preventDefault())
  voiceSession.setPermissionCheckHandler((contents, permission, origin, details) => {
    return !!trustedContents(contents) && canAccessAudio({ permission, requestingOrigin: origin,
      topLevelUrl: contents.getURL(), details }) && (syntheticAudio || systemPreferences.getMediaAccessStatus('microphone') !== 'denied')
  })
  voiceSession.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    const allowed = trustedContents(contents) && canAccessAudio({ permission,
      requestingOrigin: details.securityOrigin || details.requestingUrl, topLevelUrl: contents.getURL(), details })
    if (!allowed) { callback(false); return }
    const status = syntheticAudio ? 'granted' : systemPreferences.getMediaAccessStatus('microphone')
    let granted = status === 'granted'
    if (status === 'not-determined') {
      microphonePrompt ??= systemPreferences.askForMediaAccess('microphone').catch(() => false)
      granted = await microphonePrompt
    }
    // Denied/restricted permission never prompts again automatically.
    granted = granted && !!trustedContents(contents)
    if (!granted && trustedContents(contents)) connection.update({ type: 'denied' })
    callback(granted)
  })
  voiceSession.setDisplayMediaRequestHandler((_request, callback) => callback({}))

  const gates = new WeakMap()
  connection = new VoiceConnection({ onState: drawState, openWindow: () => {
    const window = new BrowserWindow({ width: 1100, height: 760, show: true, title: 'OBA Voice · 正在连接',
      frame: true, minimizable: true, fullscreenable: false,
      webPreferences: { session: voiceSession, preload: path.join(__dirname, 'preload.cjs'),
        nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
        backgroundThrottling: false, webviewTag: false, devTools: false,
        autoplayPolicy: 'no-user-gesture-required' } })
    gates.set(window.webContents, new MicrophoneGate())
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    window.webContents.on('will-navigate', (event, url) => { if (!isAllowedNavigation(url)) event.preventDefault() })
    window.webContents.on('will-redirect', (event, url) => { if (!isAllowedNavigation(url)) event.preventDefault() })
    window.webContents.on('page-title-updated', event => event.preventDefault())
    window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame && activeWindow() === window) {
        clearRetry()
        gates.set(window.webContents, new MicrophoneGate())
        connection.update({ type: 'reset' })
      }
    })
    window.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (mainFrame && code !== -3 && activeWindow() === window) {
        connection.update({ type: 'transport', open: false })
        scheduleRetry(window)
      }
    })
    window.webContents.on('render-process-gone', () => {
      if (activeWindow() === window) {
        connection.update({ type: 'transport', open: false })
        scheduleRetry(window)
      }
    })
    // The controller installs close/closed handlers before navigation starts.
    queueMicrotask(() => { if (!window.isDestroyed()) window.loadURL(START_URL).catch(() => scheduleRetry(window)) })
    return window
  } })

  ipcMain.on('oba-voice-window-action', (event, action) => {
    if (!canControlWindow({ action, topLevelUrl: event.sender.getURL(),
      isMainFrame: event.senderFrame === event.sender.mainFrame,
      isCurrentContents: activeWindow()?.webContents === event.sender })) return
    connection.performWindowAction(action)
  })

  ipcMain.on('oba-voice-observation', (event, observation) => {
    if (!trustedContents(event.sender) || event.senderFrame !== event.sender.mainFrame || !observation || typeof observation !== 'object') return
    const gate = gates.get(event.sender)
    if (!gate) return
    if (observation.type === 'transport' && typeof observation.open === 'boolean') {
      connection.update(observation)
      if (observation.open) { clearRetry(); retryDelay = 1000 }
      else scheduleRetry(activeWindow())
    } else if (observation.type === 'settings' && typeof observation.demand === 'boolean') {
      connection.update({ type: 'demand', enabled: observation.demand })
    } else if (observation.type === 'microphone' && typeof observation.active === 'boolean') connection.update(observation)
    else return
    if (gate.accept(observation)) event.sender.send('oba-voice-enable')
  })

  tray = new Tray(nativeImage.createEmpty())
  tray.on('click', () => connection.show())
  app.on('second-instance', () => connection.show())
  app.on('activate', () => connection.show())
  // A closed window hides; a deliberate pause may leave no windows at all.
  app.on('window-all-closed', () => {})
  app.on('before-quit', () => {
    if (nativeQuitting) return
    nativeQuitting = true
    clearRetry()
    connection.quit()
    tray.destroy()
  })
  connection.start()
}

module.exports = { main }
if (require.main === module) main().catch(error => {
  // Only fixed configuration errors reach here. No renderer text/audio is logged.
  console.error(`OBA Voice startup failed: ${error.code || error.message}`)
  require('electron').app.quit()
})
