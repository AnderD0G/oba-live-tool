import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { chromium, type BrowserContext, type Page } from 'playwright'
import type { AssistantLocalTranslationHealth, AssistantLocalTranslationResult } from '../../../../shared/assistantDesk'
import { lookupAssistantLocalPhrase } from '../../../../shared/assistantLocalPhrases'

const MAX_JOBS = 128
const MAX_INPUT = 2000
const JOB_TIMEOUT = 120_000

/** A language decision describes text only, never audience identity or location. */
export function selectLocalTranslationLanguage(detections: unknown): AssistantLocalTranslationResult {
  const uncertain = (confidence?: number): AssistantLocalTranslationResult => ({ status: 'uncertain', ...(confidence === undefined ? {} : { confidence }), error: 'LOCAL_TRANSLATION_LANGUAGE_UNCERTAIN' })
  if (!Array.isArray(detections) || !detections.length) return uncertain()
  const candidates = new Map<string, number>()
  for (const candidate of detections) {
    if (!candidate || typeof candidate.detectedLanguage !== 'string' || !/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(candidate.detectedLanguage)
      || typeof candidate.confidence !== 'number' || !Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) return uncertain()
    const language = candidate.detectedLanguage
    candidates.set(language, Math.max(candidates.get(language) ?? 0, candidate.confidence))
  }
  const ranked = [...candidates].sort((a, b) => b[1] - a[1])
  const [language, confidence] = ranked[0]
  const runnerUp = ranked[1]?.[1] ?? 0
  if (language.toLowerCase() === 'und' || confidence < 0.65 || confidence - runnerUp + Number.EPSILON < 0.15) return uncertain(confidence)
  return { status: 'ready', language, confidence }
}

// Restore the normal Chrome features used by the successful owned-profile prototype.
// In particular, Playwright's default Translate/component/network suppression disables
// public on-device APIs and their first-use language-pack downloads.
const RESTORED_FEATURES = ['AvoidUnnecessaryBeforeUnloadCheckSync', 'DestroyProfileOnBrowserClose', 'DialMediaRouteProvider', 'GlobalMediaControls', 'HttpsUpgrades', 'LensOverlay', 'MediaRouter', 'PaintHolding', 'ThirdPartyStoragePartitioning', 'BlockOriginHeaderModificationOnRedirect', 'Translate', 'AutoDeElevate', 'OptimizationHints', 'msForceBrowserSignIn', 'msEdgeUpdateLaunchServicesPreferredVersion']

// This page owns genuine buttons: Playwright clicks grant user activation for create().
// Text travels only through evaluate, never via HTTP, page markup, URLs or logs.
const OWNED_PAGE = `<!doctype html><meta charset="utf-8"><title>OBA local translation</title>
<button id="detect">Detect language</button><button id="translate">Translate text</button><script>
(() => {
  let detector, controller;
  const translators = new Map();
  window.localTranslationInput = null;
  window.localTranslationResult = null;
  const supported = value => ['available', 'downloadable', 'downloading'].includes(value);
  const destroy = resource => { try { resource?.destroy(); } catch {} };
  window.disposeLocalTranslation = () => {
    controller?.abort();
    destroy(detector); detector = null;
    for (const translator of translators.values()) destroy(translator);
    translators.clear();
    window.localTranslationInput = null; window.localTranslationResult = null;
  };
  async function execute(stage) {
    const input = window.localTranslationInput;
    controller = new AbortController();
    const signal = controller.signal;
    let result;
    try {
      if (stage === 'detect') {
        if (!detector) {
          if (!supported(await LanguageDetector.availability())) {
            result = { status: 'unsupported', error: 'LOCAL_TRANSLATION_API_UNAVAILABLE' };
          } else {
            const created = await LanguageDetector.create({ signal });
            if (signal.aborted) { destroy(created); throw new DOMException('Aborted', 'AbortError'); }
            detector = created;
          }
        }
        if (!result) result = { status: 'detected', detections: await detector.detect(input.text, { signal }) };
      } else {
        const pair = { sourceLanguage: input.language, targetLanguage: 'zh' };
        if (!supported(await Translator.availability(pair))) {
          result = { status: 'unsupported', error: 'LOCAL_TRANSLATION_LANGUAGE_UNSUPPORTED' };
        } else {
          let translator = translators.get(input.language);
          const cached = !!translator;
          const createTranslator = async () => {
            const created = await Translator.create({ ...pair, signal });
            if (signal.aborted) { destroy(created); throw new DOMException('Aborted', 'AbortError'); }
            return created;
          };
          if (translator) translators.delete(input.language);
          else {
            if (translators.size >= 8) {
              const oldest = translators.keys().next().value;
              destroy(translators.get(oldest)); translators.delete(oldest);
            }
            translator = await createTranslator();
          }
          translators.set(input.language, translator);
          let chinese;
          try { chinese = await translator.translate(input.text, { signal }); }
          catch (error) {
            // Chrome may discard cached model resources after other language packs
            // are used. Recreate only a failed cached instance, at most once, using
            // this button's activation. A new instance/input failure stays unresolved.
            if (!cached || signal.aborted || !['UnknownError', 'AbortError'].includes(error?.name)) throw error;
            destroy(translator); translators.delete(input.language);
            translator = await createTranslator();
            translators.set(input.language, translator);
            chinese = await translator.translate(input.text, { signal });
          }
          result = typeof chinese === 'string' && chinese.trim()
            ? { status: 'ready', chinese }
            : { status: 'uncertain', error: 'LOCAL_TRANSLATION_EMPTY_RESULT' };
        }
      }
    } catch {
      result = { status: 'uncertain', error: 'LOCAL_TRANSLATION_FAILED' };
    }
    if (!signal.aborted) window.localTranslationResult = { ...result, id: input.id, languages: [...translators.keys()] };
  }
  document.querySelector('#detect').onclick = () => execute('detect');
  document.querySelector('#translate').onclick = () => execute('translate');
})();
</script>`

class LocalTranslationError extends Error {
  constructor(readonly code: 'LOCAL_TRANSLATION_API_UNAVAILABLE' | 'LOCAL_TRANSLATION_FAILED') { super(code) }
}
interface Runtime { server: Server; context: BrowserContext; page: Page }
interface Job {
  id: string
  text: string
  controller: AbortController
  settled: boolean
  reason?: 'LOCAL_TRANSLATION_CANCELLED' | 'LOCAL_TRANSLATION_TIMEOUT'
  resolve(result: AssistantLocalTranslationResult): void
  cleanup(): void
}
type PageResult = (AssistantLocalTranslationResult | { status: 'detected'; detections: unknown }) & { languages: string[] }

export class ChromeLocalTranslationService {
  private readonly queue: Job[] = []
  private active?: Job
  private runtime?: Runtime
  private initializing?: Promise<Runtime>
  private resetting?: Promise<void>
  private work?: Promise<void>
  private closing?: Promise<void>
  private closed = false
  private generation = 0
  private health: Omit<AssistantLocalTranslationHealth, 'queued'> = { status: 'idle', activeLanguages: [] }

  constructor(private readonly options: { profileDirectory: string; executablePath?: string }) {}

  state(): AssistantLocalTranslationHealth {
    return { ...this.health, queued: this.queue.length + (this.active && !this.active.settled ? 1 : 0), activeLanguages: [...this.health.activeLanguages] }
  }

  translate(input: { text: string; signal: AbortSignal }): Promise<AssistantLocalTranslationResult> {
    const unresolved = (error: string, status: 'uncertain' | 'unsupported' = 'uncertain') => Promise.resolve<AssistantLocalTranslationResult>({ status, error })
    if (this.closed) return unresolved('LOCAL_TRANSLATION_CLOSED', 'unsupported')
    if (input.signal.aborted) return unresolved('LOCAL_TRANSLATION_CANCELLED')
    if (typeof input.text !== 'string' || !input.text.trim()) return unresolved('LOCAL_TRANSLATION_INPUT_EMPTY')
    if (input.text.length > MAX_INPUT) return unresolved('LOCAL_TRANSLATION_INPUT_TOO_LONG')
    const phrase = lookupAssistantLocalPhrase(input.text)
    if (phrase) return Promise.resolve({ status: 'ready', method: 'dictionary', ...phrase })
    // A detector score does not establish an unknown two-letter abbreviation's meaning.
    if (/^[A-Z]{2}$/.test(input.text.trim().replace(/[.!?。！？]+$/u, '').trim())) return unresolved('LOCAL_TRANSLATION_LANGUAGE_UNCERTAIN')
    if (this.state().queued >= MAX_JOBS) return unresolved('LOCAL_TRANSLATION_QUEUE_FULL')
    return new Promise(resolve => {
      const controller = new AbortController()
      const onAbort = () => this.cancel(job, 'LOCAL_TRANSLATION_CANCELLED')
      const timer = setTimeout(() => this.cancel(job, 'LOCAL_TRANSLATION_TIMEOUT'), JOB_TIMEOUT)
      const job: Job = {
        id: randomUUID(), text: input.text, controller, settled: false, resolve,
        cleanup: () => { clearTimeout(timer); input.signal.removeEventListener('abort', onAbort) },
      }
      input.signal.addEventListener('abort', onAbort, { once: true })
      this.queue.push(job)
      this.pump()
    })
  }

  shutdown(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    for (const job of [...this.queue]) this.cancel(job, 'LOCAL_TRANSLATION_CANCELLED')
    if (this.active) this.cancel(this.active, 'LOCAL_TRANSLATION_CANCELLED')
    this.closing = (async () => {
      await this.resetRuntime()
      await this.work
      this.health = { status: 'idle', activeLanguages: [] }
    })()
    return this.closing
  }

  private settle(job: Job, result: AssistantLocalTranslationResult): void {
    if (job.settled) return
    job.settled = true
    job.cleanup()
    job.resolve(result)
  }

  private cancel(job: Job, reason: Job['reason']): void {
    if (job.settled) return
    job.reason = reason
    job.controller.abort()
    const index = this.queue.indexOf(job)
    if (index >= 0) this.queue.splice(index, 1)
    this.settle(job, { status: 'uncertain', error: reason })
  }

  private pump(): void {
    if (this.work || this.closed) return
    this.work = this.drain().finally(() => { this.work = undefined; if (this.queue.length && !this.closed) this.pump() })
  }

  private async drain(): Promise<void> {
    while (this.queue.length && !this.closed) {
      const job = this.active = this.queue.shift()!
      try {
        const result = await this.abortable(this.process(job), job.controller.signal)
        this.settle(job, result)
      } catch (error) {
        await this.resetRuntime()
        if (job.controller.signal.aborted) {
          this.health = { status: 'idle', activeLanguages: [] }
          this.settle(job, { status: 'uncertain', error: job.reason ?? 'LOCAL_TRANSLATION_CANCELLED' })
        } else {
          const code = error instanceof LocalTranslationError ? error.code : 'LOCAL_TRANSLATION_FAILED'
          this.health = { status: code === 'LOCAL_TRANSLATION_API_UNAVAILABLE' ? 'unavailable' : 'failed', activeLanguages: [], lastError: code }
          this.settle(job, { status: code === 'LOCAL_TRANSLATION_API_UNAVAILABLE' ? 'unsupported' : 'uncertain', method: 'chrome', error: code })
        }
      } finally { this.active = undefined }
    }
  }

  private async process(job: Job): Promise<AssistantLocalTranslationResult> {
    if (job.controller.signal.aborted) throw new Error('Cancelled')
    this.health.status = 'starting'
    delete this.health.lastError
    const runtime = await this.ensureRuntime()
    if (job.controller.signal.aborted || this.closed) throw new Error('Cancelled')
    const detection = await this.stage(runtime.page, job, 'detect')
    if (detection.status !== 'detected') return this.outcome(detection)
    const selected = selectLocalTranslationLanguage(detection.detections)
    if (selected.status !== 'ready') return this.outcome(selected)
    if (/^zh(?:-|$)/i.test(selected.language!)) return this.outcome({ ...selected, chinese: job.text })
    if (job.controller.signal.aborted || this.closed) throw new Error('Cancelled')
    const translated = await this.stage(runtime.page, job, 'translate', selected.language)
    if (translated.status === 'detected') throw new LocalTranslationError('LOCAL_TRANSLATION_FAILED')
    return this.outcome({ ...selected, ...translated })
  }

  private outcome(result: AssistantLocalTranslationResult): AssistantLocalTranslationResult {
    if (result.status === 'ready' && (typeof result.chinese !== 'string' || !/\p{Script=Han}/u.test(result.chinese))) {
      result = { status: 'uncertain', language: result.language, confidence: result.confidence, error: 'LOCAL_TRANSLATION_NOT_CHINESE' }
    }
    if (result.error === 'LOCAL_TRANSLATION_FAILED') {
      this.health.status = 'failed'; this.health.lastError = result.error
    } else if (result.error === 'LOCAL_TRANSLATION_API_UNAVAILABLE') {
      this.health.status = 'unavailable'; this.health.lastError = result.error
    } else { this.health.status = 'ready'; delete this.health.lastError }
    // Do not expose page job IDs, resources, URL/error objects or detection arrays.
    return { status: result.status, method: 'chrome', ...(result.language ? { language: result.language } : {}), ...(result.confidence === undefined ? {} : { confidence: result.confidence }), ...(result.chinese === undefined ? {} : { chinese: result.chinese }), ...(result.error ? { error: result.error } : {}) }
  }

  private async stage(page: Page, job: Job, stage: 'detect' | 'translate', language?: string): Promise<PageResult> {
    await page.evaluate(input => { (window as any).localTranslationInput = input; (window as any).localTranslationResult = null }, { id: job.id, text: job.text, language })
    if (job.controller.signal.aborted) throw new Error('Cancelled')
    await page.locator(`#${stage}`).click({ timeout: 10_000 })
    const handle = await page.waitForFunction(id => (window as any).localTranslationResult?.id === id, job.id, { timeout: JOB_TIMEOUT })
    await handle.dispose()
    const result: PageResult = await page.evaluate(() => {
      const result = (window as any).localTranslationResult
      ;(window as any).localTranslationInput = null
      ;(window as any).localTranslationResult = null
      return result
    })
    if (job.controller.signal.aborted || this.closed) throw new Error('Cancelled')
    this.health.activeLanguages = result.languages
    return result
  }

  private ensureRuntime(): Promise<Runtime> {
    if (this.runtime) return Promise.resolve(this.runtime)
    if (!this.initializing) {
      const attempt = this.startRuntime(this.generation)
      this.initializing = attempt
      void attempt.finally(() => { if (this.initializing === attempt) this.initializing = undefined }).catch(() => {})
    }
    return this.initializing
  }

  private async startRuntime(generation: number): Promise<Runtime> {
    const route = `/${randomUUID()}`
    const server = createServer((request, response) => {
      if (request.method !== 'GET' || request.url !== route) { response.writeHead(404).end(); return }
      response.writeHead(200, { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; frame-ancestors 'none'" })
      response.end(OWNED_PAGE)
    })
    let context: BrowserContext | undefined
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) })
      if (this.closed || generation !== this.generation) throw new Error('Cancelled')
      context = await chromium.launchPersistentContext(this.options.profileDirectory, {
        ...(this.options.executablePath ? { executablePath: this.options.executablePath } : { channel: 'chrome' }),
        headless: true, timeout: 30_000,
        ignoreDefaultArgs: ['--disable-background-networking', '--disable-component-update', `--disable-features=${RESTORED_FEATURES.join(',')}`],
      })
      if (this.closed || generation !== this.generation) throw new Error('Cancelled')
      const page = context.pages()[0] ?? await context.newPage()
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No owned listener')
      await page.goto(`http://127.0.0.1:${address.port}${route}`, { timeout: 15_000, waitUntil: 'load' })
      const available = await page.evaluate(() => typeof (globalThis as any).LanguageDetector?.availability === 'function' && typeof (globalThis as any).LanguageDetector?.create === 'function' && typeof (globalThis as any).Translator?.availability === 'function' && typeof (globalThis as any).Translator?.create === 'function')
      if (!available) throw new LocalTranslationError('LOCAL_TRANSLATION_API_UNAVAILABLE')
      if (this.closed || generation !== this.generation) throw new Error('Cancelled')
      return this.runtime = { context, page, server }
    } catch (error) {
      await this.closeResources(server, context)
      throw error instanceof LocalTranslationError ? error : new LocalTranslationError('LOCAL_TRANSLATION_FAILED')
    }
  }

  private resetRuntime(): Promise<void> {
    if (this.resetting) return this.resetting
    this.generation++
    const starting = this.initializing
    this.resetting = (async () => {
      await starting?.catch(() => {})
      const runtime = this.runtime
      this.runtime = undefined
      if (runtime) await this.closeResources(runtime.server, runtime.context, runtime.page)
      this.health.activeLanguages = []
    })().finally(() => { this.resetting = undefined })
    return this.resetting
  }

  private async closeResources(server: Server, context?: BrowserContext, page?: Page): Promise<void> {
    if (page && !page.isClosed()) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([page.evaluate(() => (window as any).disposeLocalTranslation?.()).catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, 1_000) })])
      } finally { clearTimeout(timer) }
    }
    try { await context?.close() } catch { /* Closing the owned browser must not retain the listener. */ }
    finally {
      server.closeAllConnections()
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }

  private abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) { void operation.catch(() => {}); return Promise.reject(new Error('Cancelled')) }
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new Error('Cancelled'))
      signal.addEventListener('abort', abort, { once: true })
      void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }
}
