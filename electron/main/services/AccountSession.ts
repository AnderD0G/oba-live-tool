import { randomUUID } from 'node:crypto'
import { Result } from '@praha/byethrow'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { TaskNotSupportedError } from '#/errors/AppError'
import { emitter } from '#/event/eventBus'
import { createLogger } from '#/logger'
import {
  type BrowserSession,
  browserManager,
  type StorageState,
} from '#/managers/BrowserSessionManager'
import { platformFactory } from '#/platforms'
import {
  type IPlatform,
  isBusinessDataSource,
  isCommentListener,
  isConfigurablePlatform,
  isLoginFirstPlatform,
  isPerformComment,
  isPerformPopup,
  isPinComment,
  isSendRedPacket,
  isTranslationObserver,
} from '#/platforms/IPlatform'
import { createAutoCommentTask } from '#/tasks/AutoCommentTask'
import { createAutoPopupTask } from '#/tasks/AutoPopupTask'
import { createCommentListenerTask } from '#/tasks/CommentListenerTask'
import type { ITask } from '#/tasks/ITask'
import { createPinCommentTask } from '#/tasks/PinCommentTask'
import { createSendBatchMessageTask } from '#/tasks/SendBatchMessageTask'
import windowManager from '#/windowManager'
import type { AnalysisCapabilities, AnalysisScope } from '../../../shared/analysisRoom'
import type { PlatformPageDiagnostics } from '../../../shared/platformPageDiagnostics'
import {
  PlatformSessionError,
  parseTikTokLiveTarget,
  parseTikTokAttachPage,
  validateBrowserAttachEndpoint,
  type PlatformLoginQrPreview,
  type PlatformSessionState,
} from '../../../shared/platformSession'
import { readTikTokPageDiagnostics } from '../platforms/tiktok/pageDiagnostics'
import { sameTikTokLivePage } from '../platforms/tiktok/livePageIdentity'
import { CommentSubscriptionCoordinator } from './CommentSubscriptionCoordinator'
import type { BrowserTranslationObservation } from '../../../shared/browserTranslation'

export class AccountSession {
  readonly instanceId = randomUUID()
  private platform: IPlatform
  private browserSession: BrowserSession | null = null
  private activeTasks: Map<LiveControlTask['type'], ITask> = new Map()
  private liveAccountName = ''
  private replyLifecycle = new AbortController()
  private commentSubscriptions?: CommentSubscriptionCoordinator
  private commentSubscriptionCleanup?: Promise<void>
  private readonly platformKey: LiveControlPlatform
  private analysisAuthenticated = false
  private loginFirstMode = false
  private loginFirstRoomReady = false
  private browserSessionId?: string
  private platformSessionOperation?: symbol
  private removeLoginPageClose?: () => void
  private saveLoginState?: (storageState: string) => void | Promise<void>
  private savedLoginState?: string
  private loginCheckpointTail: Promise<void> = Promise.resolve()
  private browserReleaseTail: Promise<void> = Promise.resolve()

  constructor(
    platformName: LiveControlPlatform,
    private account: Account,
    platformConfig?: LivePlatformConfig,
    private logger = createLogger(`@${account.name}`),
  ) {
    this.platformKey = platformName
    this.platform = new platformFactory[platformName]()
    if (platformConfig && isConfigurablePlatform(this.platform)) {
      this.platform.configure(platformConfig)
    }
  }

  async performDirectorPopup(id: number, signal: AbortSignal) {
    signal.throwIfAborted()
    if (!isPerformPopup(this.platform)) throw new Error('当前平台不支持商品讲解弹窗')
    // 防御性调用：确保定时弹窗没在跟我抢。没在跑是常态，所以不要出声。
    this.stopTask('auto-popup', true)
    const result = await this.platform.performPopup(id, signal)
    if (Result.isFailure(result)) throw result.error
  }

  async connect(config: { headless?: boolean; storageState?: string }) {
    if (this.platformSessionOperation) throw new PlatformSessionError('SESSION_BUSY', '账号会话操作正在进行，请稍后重试')
    this.loginFirstMode = false
    this.analysisAuthenticated = false
    this.commentSubscriptions?.invalidate('reconnected')
    this.commentSubscriptions = undefined
    this.replyLifecycle.abort()
    this.replyLifecycle = new AbortController()
    let storageState: StorageState
    if (config.storageState) {
      this.logger.info('检测到已保存登录状态')
      storageState = JSON.parse(config.storageState)
    }

    this.browserSession = await browserManager.createSession(config.headless, storageState)

    await this.ensureAuthenticated(this.browserSession, config.headless)

    const state = JSON.stringify(await this.browserSession.context.storageState())
    this.analysisAuthenticated = true
    this.browserSessionId = randomUUID()

    // 登录成功之后马上先保存一次登录状态，确保后续发生意外后不用重新登录
    windowManager.send(IPC_CHANNELS.chrome.saveState, this.account.id, state)

    // 此时可以确保正在中控台页面，获取用户名
    // 获取用户名不应该和连接中控台的行为冲突
    this.platform
      .getAccountName(this.browserSession)
      .then(accountName => {
        this.liveAccountName = accountName ?? ''
        windowManager.send(IPC_CHANNELS.tasks.liveControl.notifyAccountName, {
          ok: true,
          accountId: this.account.id,
          accountName,
        })
      })
      .catch(error => {
        this.logger.error('获取用户名失败：', error)
        windowManager.send(IPC_CHANNELS.tasks.liveControl.notifyAccountName, {
          ok: false,
        })
      })

    // 浏览器被外部主动关闭时，程序自动断开所有操作
    // 不用 browserContext close 或 browser disconnected 的原因：
    // Windows 手动关闭浏览器时（点击右上角的x或标签页的x）无法触发相应事件
    // 只会触发 page close，所以没办法
    const replyLifecycle = this.replyLifecycle
    this.browserSession.page.on('close', () => {
      if (this.replyLifecycle !== replyLifecycle || replyLifecycle.signal.aborted) return
      replyLifecycle.abort()
      this.analysisAuthenticated = false
      this.commentSubscriptions?.invalidate('page-closed')
      emitter.emit('page-closed', { accountId: this.account.id, sessionId: this.instanceId })
    })
    this.logger.success('成功与中控台建立连接')
  }

  disconnect() {
    this.analysisAuthenticated = false
    this.replyLifecycle.abort()
    this.commentSubscriptions?.invalidate('disconnected')
    emitter.emit('comment-listener-stopped', { accountId: this.account.id })
    this.logger.warn('与中控台断开连接')
    // 通过程序关闭浏览器（并非多余的操作，因为 MacOS 的 context 关闭时不会关闭浏览器进程）
    const browserSession = this.browserSession
    const platform = this.platform
    this.browserSession = null
    this.browserSessionId = undefined
    this.loginFirstRoomReady = false
    this.removeLoginPageClose?.()
    this.removeLoginPageClose = undefined
    if (browserSession) {
      // Stop injected observers before detaching from a user-owned browser.
      this.browserReleaseTail = Promise.resolve()
        .then(() => typeof platform.disconnect === 'function' ? platform.disconnect() : undefined)
        .catch(() => { this.logger.warn('平台监听清理失败，将释放本机浏览器连接') })
        .then(() => browserSession.release ? browserSession.release() : browserSession.browser.close())
        .catch(() => { this.logger.warn('浏览器连接释放失败') })
    }
    // 关闭所有正在进行的任务
    Array.from(this.activeTasks.values()).forEach(task => {
      task.stop()
    })
    this.activeTasks.clear()
    // 通知渲染层
    windowManager.send(IPC_CHANNELS.tasks.liveControl.disconnectedEvent, this.account.id)
  }

  private sessionBusy() {
    return !!this.platformSessionOperation || this.activeTasks.size > 0 || !!this.commentSubscriptions?.activeSource
  }

  private requireLoginFirstPlatform() {
    if (!isLoginFirstPlatform(this.platform)) throw new PlatformSessionError('UNSUPPORTED_PLATFORM', '当前平台不支持登录先行')
    return this.platform
  }

  private currentPlatformSession(expectedSessionId?: string) {
    const platform = this.requireLoginFirstPlatform()
    const session = this.browserSession
    if (expectedSessionId !== undefined && expectedSessionId !== this.browserSessionId)
      throw new PlatformSessionError('SESSION_CHANGED', '账号浏览器会话已变化，请刷新后重试')
    if (!session || session.page.isClosed() || this.replyLifecycle.signal.aborted)
      throw new PlatformSessionError('SESSION_CLOSED', '请先打开账号登录浏览器')
    if (!this.browserSessionId) this.browserSessionId = randomUUID()
    const page = session.page
    const sessionId = this.browserSessionId
    const lifecycle = this.replyLifecycle
    const assertCurrent = () => {
      if (this.browserSession !== session || session.page !== page || this.platform !== platform ||
        this.browserSessionId !== sessionId || this.replyLifecycle !== lifecycle || lifecycle.signal.aborted || page.isClosed())
        throw new PlatformSessionError('SESSION_CHANGED', '操作期间账号浏览器会话已变化，请刷新后重试')
    }
    return { session, platform, assertCurrent }
  }

  private installLoginPageClose(session: BrowserSession) {
    this.removeLoginPageClose?.()
    const page = session.page
    const lifecycle = this.replyLifecycle
    const closed = () => {
      if (this.browserSession !== session || session.page !== page || this.replyLifecycle !== lifecycle || lifecycle.signal.aborted) return
      lifecycle.abort()
      this.analysisAuthenticated = false
      this.loginFirstRoomReady = false
      this.commentSubscriptions?.invalidate('page-closed')
      emitter.emit('page-closed', { accountId: this.account.id, sessionId: this.instanceId })
    }
    page.on('close', closed)
    this.removeLoginPageClose = () => page.off('close', closed)
  }

  /** Opens the owned visible browser and returns promptly; the user completes login manually. */
  public async openLoginBrowser(config: { storageState?: string; onStorageState?: (storageState: string) => void | Promise<void> } = {}): Promise<PlatformSessionState> {
    const platform = this.requireLoginFirstPlatform()
    if (this.browserSession && !this.browserSession.page.isClosed() && !this.replyLifecycle.signal.aborted)
      return this.getPlatformSessionState()
    if (this.sessionBusy()) throw new PlatformSessionError('SESSION_BUSY', '请先停止账号监听和任务')
    const operation = Symbol('open-login')
    this.platformSessionOperation = operation
    this.loginFirstMode = true
    this.loginFirstRoomReady = false
    this.analysisAuthenticated = false
    this.replyLifecycle.abort()
    this.replyLifecycle = new AbortController()
    const lifecycle = this.replyLifecycle
    try {
      await this.browserReleaseTail
      if (this.replyLifecycle !== lifecycle || lifecycle.signal.aborted || this.platform !== platform)
        throw new PlatformSessionError('SESSION_CHANGED', '打开期间账号会话已变化，请重试')
      const storageState: StorageState = config.storageState ? JSON.parse(config.storageState) : undefined
      this.saveLoginState = config.onStorageState
      this.savedLoginState = undefined
      const session = await browserManager.createSession(false, storageState)
      if (this.replyLifecycle !== lifecycle || lifecycle.signal.aborted || this.platform !== platform) {
        await session.browser.close().catch(() => {})
        throw new PlatformSessionError('SESSION_CHANGED', '打开期间账号会话已变化，请重试')
      }
      this.browserSession = session
      this.browserSessionId = randomUUID()
      // Installed before navigation or login reads so closing a pending login is observable.
      this.installLoginPageClose(session)
      const { assertCurrent } = this.currentPlatformSession()
      await platform.openLoginBrowser(session)
      assertCurrent()
      const state = await this.getPlatformSessionState()
      assertCurrent()
      return { ...state, busy: false }
    } finally {
      if (this.platformSessionOperation === operation) this.platformSessionOperation = undefined
    }
  }

  public async attachBrowser(endpoint: string, pageUrl: string): Promise<PlatformSessionState> {
    validateBrowserAttachEndpoint(endpoint)
    parseTikTokAttachPage(pageUrl)
    const platform = this.requireLoginFirstPlatform()
    if (!platform.attachLoginBrowser) throw new PlatformSessionError('UNSUPPORTED_PLATFORM', '当前平台不支持接入现有浏览器')
    if (this.sessionBusy() || (this.browserSession && !this.browserSession.page.isClosed() && !this.replyLifecycle.signal.aborted))
      throw new PlatformSessionError('SESSION_BUSY', '账号已有浏览器、监听或任务，请先断开后再接入')
    const operation = Symbol('attach-browser')
    this.platformSessionOperation = operation
    this.replyLifecycle.abort()
    this.replyLifecycle = new AbortController()
    const lifecycle = this.replyLifecycle
    const assertAttempt = () => {
      if (this.replyLifecycle !== lifecycle || lifecycle.signal.aborted || this.platform !== platform)
        throw new PlatformSessionError('SESSION_CHANGED', '接入期间账号会话已变化，请重试')
    }
    let session: BrowserSession | undefined
    try {
      await this.browserReleaseTail
      assertAttempt()
      session = await browserManager.attachSession(endpoint, pageUrl)
      assertAttempt()
      this.commentSubscriptions = undefined
      this.browserSession = session
      this.browserSessionId = randomUUID()
      this.loginFirstMode = true
      this.loginFirstRoomReady = false
      this.analysisAuthenticated = false
      // The user's profile stays in the original Chrome; never serialize it to a new browser.
      this.saveLoginState = undefined
      this.savedLoginState = undefined
      this.installLoginPageClose(session)
      await platform.attachLoginBrowser(session, pageUrl)
      assertAttempt()
      const { assertCurrent } = this.currentPlatformSession()
      const state = await this.getPlatformSessionState()
      assertCurrent()
      if (state.loginStatus !== 'authenticated') throw new PlatformSessionError('LOGIN_REQUIRED', '请先在原 Chrome 中完成 TikTok 登录')
      if (!state.roomReady) throw new PlatformSessionError('ROOM_NOT_READY', '现有直播页面还未准备好')
      return { ...state, captureReady: true, busy: false }
    } catch (error) {
      if (session && this.browserSession === session && this.replyLifecycle === lifecycle) {
        this.removeLoginPageClose?.()
        this.removeLoginPageClose = undefined
        this.browserSession = null
        this.browserSessionId = undefined
        this.analysisAuthenticated = false
        this.loginFirstRoomReady = false
        lifecycle.abort()
        await platform.disconnect().catch(() => {})
      }
      if (session) await (session.release ? session.release() : session.browser.close()).catch(() => {})
      throw error
    } finally {
      if (this.platformSessionOperation === operation) this.platformSessionOperation = undefined
    }
  }

  public async getPlatformSessionState(): Promise<PlatformSessionState> {
    const supported = isLoginFirstPlatform(this.platform)
    const base = { accountId: this.account.id, platform: this.platformKey, supported, busy: this.sessionBusy() }
    if (!supported || !this.browserSession || this.browserSession.page.isClosed() || this.replyLifecycle.signal.aborted)
      return { ...base, browserOpen: false, loginStatus: 'closed', roomReady: false, captureReady: false }
    const { session, platform, assertCurrent } = this.currentPlatformSession()
    const snapshot = await platform.getPlatformSessionState(session)
    assertCurrent()
    this.analysisAuthenticated = snapshot.loginStatus === 'authenticated'
    this.loginFirstRoomReady = this.analysisAuthenticated && snapshot.roomReady === true
    if (this.analysisAuthenticated && this.saveLoginState) {
      const save = this.saveLoginState
      const checkpoint = this.loginCheckpointTail.then(async () => {
        assertCurrent()
        const serialized = JSON.stringify(await session.context.storageState())
        assertCurrent()
        if (this.saveLoginState !== save) throw new PlatformSessionError('SESSION_CHANGED', '账号登录状态保存器已变化')
        if (this.savedLoginState !== serialized) {
          await save(serialized)
          assertCurrent()
          this.savedLoginState = serialized
        }
      })
      this.loginCheckpointTail = checkpoint.catch(() => {})
      await checkpoint
      assertCurrent()
    }
    const target = snapshot.target ? parseTikTokLiveTarget(snapshot.target.username) : undefined
    return {
      ...base, busy: this.sessionBusy(), browserOpen: true, sessionId: this.browserSessionId,
      loginStatus: this.analysisAuthenticated ? 'authenticated' : 'required',
      ...(target ? { target } : {}), roomReady: this.loginFirstRoomReady,
      captureReady: this.loginFirstRoomReady && !this.platformSessionOperation,
    }
  }

  public async setLiveTarget(target: string, expectedSessionId?: string): Promise<PlatformSessionState> {
    const parsed = parseTikTokLiveTarget(target)
    const { session, platform, assertCurrent } = this.currentPlatformSession(expectedSessionId)
    if (this.sessionBusy()) throw new PlatformSessionError('SESSION_BUSY', '请先停止账号监听和任务，再切换直播间')
    const operation = Symbol('set-target')
    this.platformSessionOperation = operation
    this.loginFirstRoomReady = false
    try {
      const login = await platform.getPlatformSessionState(session)
      assertCurrent()
      if (login.loginStatus !== 'authenticated') throw new PlatformSessionError('LOGIN_REQUIRED', '请先在账号浏览器中完成 TikTok 登录')
      // A new consumer or task may have arrived while the login probe was pending.
      if (this.activeTasks.size > 0 || this.commentSubscriptions?.activeSource)
        throw new PlatformSessionError('SESSION_BUSY', '请先停止账号监听和任务，再切换直播间')
      this.replyLifecycle.abort()
      this.replyLifecycle = new AbortController()
      this.commentSubscriptions?.invalidate('target-changed')
      this.commentSubscriptions = undefined
      this.installLoginPageClose(session)
      const current = this.currentPlatformSession(expectedSessionId)
      await platform.setLiveTarget(session, parsed.username)
      current.assertCurrent()
      const state = await this.getPlatformSessionState()
      current.assertCurrent()
      return { ...state, captureReady: state.roomReady, busy: false }
    } finally {
      if (this.platformSessionOperation === operation) this.platformSessionOperation = undefined
    }
  }

  public async getLoginQrPreview(expectedSessionId?: string): Promise<PlatformLoginQrPreview> {
    const { session, platform, assertCurrent } = this.currentPlatformSession(expectedSessionId)
    if (this.platformSessionOperation) throw new PlatformSessionError('SESSION_BUSY', '账号页面正在切换，请稍后重试')
    const preview = await platform.getLoginQrPreview(session)
    assertCurrent()
    return { mimeType: 'image/png', dataUrl: preview.dataUrl, capturedAt: preview.capturedAt, width: preview.width, height: preview.height }
  }

  private async ensureAuthenticated(session: BrowserSession, headless = true) {
    this.browserSession = session
    const isConnected = await this.platform.connect(this.browserSession)
    // 未登录，需要等待登录
    if (!isConnected) {
      // 无头模式，需要先关闭原先的无头模式，启用有头模式给用户登录
      if (headless) {
        await this.browserSession.browser.close()
        this.logger.info('需要登录，请在打开的浏览器中登录')
        this.browserSession = await browserManager.createSession(false)
      }
      // 等待登录
      await this.platform.login(this.browserSession)
      // 保存登录状态
      const storageState = await this.browserSession.context.storageState()
      // 无头模式，需要先关闭当前的有头模式，重新打开无头模式
      if (headless) {
        await this.browserSession.browser.close()
        this.logger.info('登录成功，浏览器将继续以无头模式运行')
        this.browserSession = await browserManager.createSession(headless, storageState)
      }
      await this.ensureAuthenticated(this.browserSession, headless)
    }
  }

  public async startTask(task: LiveControlTask): Result.ResultAsync<void, Error> {
    if (this.platformSessionOperation || (this.loginFirstMode && (!this.analysisAuthenticated || !this.loginFirstRoomReady)))
      return Result.fail(new PlatformSessionError('ROOM_NOT_READY', '请先完成账号登录并选择直播间'))
    if (task.type === 'comment-listener' && this.activeTasks.get(task.type)?.isRunning()) {
      return Result.fail(new Error('评论监听已在启动或运行，请先停止或修改现有配置'))
    }
    const newTask = makeTask(
      task,
      this.platform,
      this.account,
      this.logger,
      task.type === 'comment-listener' && isCommentListener(this.platform)
        ? this.getCommentSubscriptions()
        : undefined,
    )
    if (Result.isFailure(newTask)) {
      return newTask
    }
    // 任务停止时从任务列表中移除
    newTask.value.addStopListener(() => {
      if (this.activeTasks.get(task.type) === newTask.value) this.activeTasks.delete(task.type)
    })
    this.activeTasks.set(task.type, newTask.value)
    await newTask.value.start()
    if (task.type === 'comment-listener' && !newTask.value.isRunning()) {
      return Result.fail(new Error('评论监听启动失败或已取消'))
    }
    return Result.succeed()
  }

  /**
   * 停掉某个任务。
   *
   * `quiet` 是给**内部防御性调用**用的：`performDirectorPopup` 每次弹卡前都会
   * 确保定时弹窗没在跑，而"它本来就没在跑"是完全正常的情况 ——
   * 不该每弹一次卡就刷一行 WARN（001 那三条重复时间点刷了四行）。
   * 用户手点「停止」时不算 quiet：那时候"没有正在运行的任务"是有用信息。
   */
  public stopTask(taskType: LiveControlTask['type'], quiet = false) {
    const task = this.activeTasks.get(taskType)
    if (task) {
      task.stop()
    } else if (!quiet) {
      this.logger.warn('无法停止任务：未找到正在运行中的任务')
    }
  }

  public codexAutoReady() {
    return this.liveInteractionReady() && 'performConfirmedComment' in this.platform
  }
  public getPlatformName() {
    return this.platform.platformName
  }
  public getAnalysisScope(): AnalysisScope {
    return {
      accountId: this.account.id,
      platform: this.platformKey,
      source: this.commentSubscriptions?.activeSource ?? 'control',
    }
  }
  public getAnalysisCapabilities(scope: AnalysisScope): AnalysisCapabilities {
    const connected =
      scope.accountId === this.account.id &&
      scope.platform === this.platformKey &&
      this.analysisAuthenticated &&
      (!this.loginFirstMode || this.loginFirstRoomReady) &&
      !!this.browserSession &&
      !this.browserSession.page.isClosed()
    const capability =
      isBusinessDataSource(this.platform)
        ? this.platform.businessCapabilities()
        : undefined
    const sources = capability?.sources ?? []
    return {
      scope: { ...scope },
      connected,
      supported: sources.includes(scope.source),
      sources: [...sources],
      ...(capability ? { formatVersion: capability.formatVersion } : {}),
      ...(this.platformKey === 'tiktok' && capability?.captureTransports
        ? { captureTransports: { ...capability.captureTransports } }
        : {}),
      limits: { maxBytes: 131072, maxDepth: 16 },
      ...(!connected
        ? { reason: '请先完成中控台登录' }
        : !sources.includes(scope.source)
          ? { reason: '该来源暂不支持原始业务分析' }
          : {}),
    }
  }
  public async getPageDiagnostics(marker?: string): Promise<PlatformPageDiagnostics> {
    if (this.platformKey !== 'tiktok' || !isCommentListener(this.platform)) {
      throw new Error('只读页面诊断仅支持 TikTok')
    }
    const session = this.browserSession
    const platform = this.platform
    if (!this.analysisAuthenticated || !session || session.page.isClosed()) {
      throw new Error('请先完成账号连接和登录，保持页面打开')
    }
    const browserPage = session.page
    const page = platform.getCommentListenerPage()
    if (page.isClosed()) throw new Error('账号页面已关闭')

    const diagnostics = await readTikTokPageDiagnostics(page, marker)
    if (
      !this.analysisAuthenticated ||
      this.browserSession !== session ||
      this.platform !== platform ||
      session.page !== browserPage ||
      browserPage.isClosed() ||
      page.isClosed()
    ) {
      throw new Error('读取期间账号连接或页面发生变化，请重试')
    }
    try {
      if (platform.getCommentListenerPage() !== page) {
        throw new Error('读取期间账号页面发生变化，请重试')
      }
    } catch {
      throw new Error('读取期间账号页面发生变化或关闭，请重试')
    }
    return platform.getSdkNetworkDiagnostics
      ? { ...diagnostics, sdkNetwork: platform.getSdkNetworkDiagnostics(marker) }
      : diagnostics
  }
  public subscribeTranslations(listener: (observation: BrowserTranslationObservation) => void): () => void {
    const platform = this.platform, browser = this.browserSession, lifecycle = this.replyLifecycle
    if (!isTranslationObserver(platform) || !this.analysisAuthenticated || !browser || browser.page.isClosed() ||
      this.platformSessionOperation || (this.loginFirstMode && !this.loginFirstRoomReady)) return () => {}
    const page = browser.page
    let released = false
    const unsubscribe = platform.subscribeTranslations(observation => {
      if (released || this.platform !== platform || this.browserSession !== browser || browser.page !== page ||
        this.replyLifecycle !== lifecycle || lifecycle.signal.aborted || !this.analysisAuthenticated || page.isClosed() ||
        (this.loginFirstMode && !this.loginFirstRoomReady)) return
      listener(observation)
    })
    return () => { if (!released) { released = true; unsubscribe() } }
  }
  public getCommentSubscriptions(): CommentSubscriptionCoordinator {
    if (this.platformSessionOperation || (this.loginFirstMode && (!this.analysisAuthenticated || !this.loginFirstRoomReady)))
      throw new PlatformSessionError('ROOM_NOT_READY', '请先完成账号登录并选择直播间')
    if (!isCommentListener(this.platform)) throw new Error('当前平台不支持评论监听')
    if (!this.commentSubscriptions || this.commentSubscriptions.isClosed) {
      const browser = this.browserSession, platform = this.platform, lifecycle = this.replyLifecycle
      const page = browser?.page
      const selectedPageUrl = this.platformKey === 'tiktok' && page ? page.url() : undefined
      const coordinator = new CommentSubscriptionCoordinator({
        scope: { accountId: this.account.id, platform: this.platformKey, source: 'control' },
        listener: this.platform,
        waitForCleanup: this.commentSubscriptionCleanup,
        beforeStart: this.platformKey === 'tiktok' ? () => {
          if (this.platformSessionOperation || this.browserSession !== browser || this.platform !== platform ||
            this.replyLifecycle !== lifecycle || lifecycle.signal.aborted || !page || page.isClosed() ||
            browser?.page !== page || !this.analysisAuthenticated ||
            (this.loginFirstMode && !this.loginFirstRoomReady) ||
            (selectedPageUrl !== undefined && !sameTikTokLivePage(page.url(), selectedPageUrl))) {
            if (this.browserSession === browser && this.platform === platform && this.replyLifecycle === lifecycle)
              this.loginFirstRoomReady = false
            throw new PlatformSessionError('ROOM_NOT_READY', '监听启动期间账号页面已变化，请重新选择直播间')
          }
        } : undefined,
        observeBusiness: observation => emitter.emit('business-observation', observation),
        onInvalidated: reason => {
          this.commentSubscriptionCleanup = coordinator.cleanupComplete
          if (reason === 'PAGE_CHANGED' || reason === 'PAGE_CLOSED') this.loginFirstRoomReady = false
          emitter.emit('business-listener-invalidated', { accountId: this.account.id, reason })
        },
        onError: reason => this.logger.warn(reason),
      })
      this.commentSubscriptions = coordinator
    }
    return this.commentSubscriptions
  }
  public liveInteractionReady() {
    return (
      !!this.browserSession &&
      !this.browserSession.page.isClosed() &&
      this.activeTasks.get('comment-listener')?.isRunning() === true
    )
  }

  public getLiveAccountName() {
    return this.liveAccountName
  }

  private replyTail: Promise<unknown> = Promise.resolve()
  /** Assistant capture owns a coordinator lease, without enabling the legacy global reply task. */
  public async sendAssistantReply(message: string, signal: AbortSignal): Promise<boolean> {
    const browser = this.browserSession
    const platform = this.platform
    const page = browser?.page
    const lifecycle = this.replyLifecycle
    const combinedSignal = AbortSignal.any([signal, lifecycle.signal])
    const send = this.replyTail.then(async () => {
      const ready = () => !!browser && !!page && !page.isClosed() && this.browserSession === browser && browser.page === page &&
        this.platform === platform && this.replyLifecycle === lifecycle && !combinedSignal.aborted &&
        this.analysisAuthenticated && (!this.loginFirstMode || this.loginFirstRoomReady) &&
        !this.platformSessionOperation && !!this.commentSubscriptions?.activeSource
      if (!ready() || !browser || !('performConfirmedComment' in platform) || typeof platform.performConfirmedComment !== 'function') return false
      if (isLoginFirstPlatform(platform)) {
        const snapshot = await platform.getPlatformSessionState(browser)
        if (!ready() || snapshot.loginStatus !== 'authenticated' || !snapshot.roomReady) return false
      }
      return platform.performConfirmedComment(message, combinedSignal) as Promise<boolean>
    })
    this.replyTail = send.catch(() => false)
    return send
  }

  public async sendCodexReply(message: string, signal: AbortSignal): Promise<boolean> {
    const combinedSignal = AbortSignal.any([signal, this.replyLifecycle.signal])
    const browser = this.browserSession
    const platform = this.platform
    const send = this.replyTail.then(async () => {
      if (
        !this.codexAutoReady() ||
        combinedSignal.aborted ||
        this.browserSession !== browser ||
        this.platform !== platform
      )
        return false
      return (
        platform as IPlatform & {
          performConfirmedComment: (text: string, signal: AbortSignal) => Promise<boolean>
        }
      ).performConfirmedComment(message, combinedSignal)
    })
    this.replyTail = send.catch(() => false)
    return send
  }

  public async sendRedPacket(duration: string): Result.ResultAsync<void, Error> {
    if (!isSendRedPacket(this.platform)) {
      return Result.fail(
        new TaskNotSupportedError({
          taskName: '一键发红包',
          targetName: this.platform.platformName,
        }),
      )
    }
    return this.platform.sendRedPacket(duration)
  }

  public updateTaskConfig<T extends LiveControlTask>(
    type: T['type'],
    config: Partial<T['config']>,
  ): Result.Result<void, Error> {
    const task = this.activeTasks.get(type)
    if (task?.updateConfig) {
      return task.updateConfig(config)
    }
    return Result.fail(new TaskNotSupportedError({ taskName: `update-${type}` }))
  }
}

function makeTask<T extends LiveControlTask>(
  task: T,
  platform: IPlatform,
  account: Account,
  logger: ReturnType<typeof createLogger>,
  subscriptions?: CommentSubscriptionCoordinator,
): Result.Result<ITask, Error> {
  if (task.type === 'auto-popup' && isPerformPopup(platform)) {
    return createAutoPopupTask(platform, task.config, account, logger)
  }
  if (task.type === 'auto-comment' && isPerformComment(platform)) {
    return createAutoCommentTask(platform, task.config, account, logger)
  }
  if (task.type === 'send-batch-messages' && isPerformComment(platform)) {
    return createSendBatchMessageTask(platform, task.config, logger)
  }
  if (task.type === 'comment-listener' && isCommentListener(platform)) {
    return createCommentListenerTask(platform, task.config, account, logger, subscriptions)
  }
  if (task.type === 'pin-comment' && isPinComment(platform)) {
    return createPinCommentTask(platform, task.config.comment, account.id, logger)
  }
  return Result.fail(
    new TaskNotSupportedError({
      taskName: task.type,
      targetName: platform.platformName,
    }),
  )
}
