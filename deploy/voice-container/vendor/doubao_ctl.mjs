/**
 * 豆包语音转文字 · API 服务
 *
 * 目标：把「我说的话」转成文字，通过 HTTP API 返还给调用方。
 *      豆包自己的回复不参与，也**不发送**（发送只会把文字推进对话，没意义）。
 *
 * API（都带 CORS，别的系统 / 网页可以直接调）：
 *   POST /api/rec/start   开始录音
 *   POST /api/rec/stop    结束录音 → 等识别完成 → 返回 { ok, text } → 清空输入框
 *   GET  /api/state       当前状态（录音中？输入框里有什么？）
 *   POST /api/clear       手动清空输入框
 *   GET  /                状态页（只是用来看状态，不点也行）
 *
 * 实现要点（都是实测踩出来的）：
 *   - 豆包语音不是"点按钮"，是**按住空格说话**，所以要模拟 keyDown/keyUp Space
 *   - keyDown 必须用 type:'keyDown' 且带 text —— rawKeyDown 不产生 DOM keydown
 *   - 跨连接时焦点会丢，所以每次录音前先点一下输入框
 *   - 不发送就必须清空输入框，否则下次识别结果会接在旧文字后面
 *   - 常驻单连接：Chrome 的 DevTools 端点释放慢，反复新建连接会超时
 *
 * 用法：node doubao_ctl.mjs     然后浏览器开 http://127.0.0.1:7799
 */
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import http from 'node:http'

const require = createRequire(import.meta.url)
const WS = require('ws')

// 独立的 Chrome 专用端口。为什么不复用原来的 9222：
//   原来那个 Chrome 是默认用户目录 + 别人也在用 CDP，两边会抢同一个 DevTools 端点
//   （Chrome 同一时刻只允许一个连接）。所以另开一个独立 Chrome：
//     chrome.exe --remote-debugging-port=9223 --user-data-dir=C:\Users\luizs\OBA-chrome-doubao
//   独立用户目录还有个好处：HTTP 端点 /json/version 能正常用（默认目录下 Chrome 136+
//   会忽略 --remote-debugging-port，HTTP 一律 404，只能去读 DevToolsActivePort 文件）。
const CDP_PORT = Number(process.env.DOUBAO_CDP_PORT || 9223)
// 默认只听本机。要让 Mac / 别的机器连，设 DOUBAO_BIND=0.0.0.0（需同时放行防火墙）
const BIND = process.env.DOUBAO_BIND || '127.0.0.1'
const HTTP_PORT = Number(process.env.DOUBAO_PORT || 7799)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(`[${new Date().toTimeString().slice(0, 8)}]`, ...a)

/** 直接问 Chrome 要 WebSocket 地址（比读 DevToolsActivePort 文件稳） */
async function discoverWsUrl() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
  if (!res.ok) throw new Error(`Chrome 调试端点返回 HTTP ${res.status}`)
  const j = await res.json()
  if (!j.webSocketDebuggerUrl) throw new Error('Chrome 没给出 webSocketDebuggerUrl')
  return j.webSocketDebuggerUrl
}

/** 把文字写进 Windows 剪贴板（clip.exe 从 stdin 读） */
function toClipboard(text) {
  try {
    const r = spawnSync('clip', [], { input: text, encoding: 'utf8', windowsHide: true })
    return r.status === 0
  } catch { return false }
}

// ---------------- CDP ----------------
class Cdp {
  constructor() { this.id = 0; this.pending = new Map(); this.sid = null; this.connected = false }

  async connect() {
    const url = await discoverWsUrl()
    return new Promise((resolve, reject) => {
      try { this.ws?.terminate() } catch {}
      this.ws = new WS(url, { handshakeTimeout: 40000, perMessageDeflate: false })
      // 40 秒超时：Chrome 会弹「允许调试」授权框，要留够人手点的时间。
      const t = setTimeout(() => { try { this.ws.terminate() } catch {}; reject(new Error('连 CDP 超时（Chrome 的「允许调试」框是不是没点？）')) }, 40000)
      this.ws.on('open', () => { clearTimeout(t); this.connected = true; log('CDP 已连接 ' + url.slice(0, 60)); resolve() })
      this.ws.on('error', e => { clearTimeout(t); this.connected = false; log('CDP 错误: ' + e.message); reject(e) })
      this.ws.on('close', (c, r) => { this.connected = false; this.sid = null; log(`CDP 断开 code=${c} ${r.toString().slice(0,80)}`) })
      this.ws.on('message', raw => {
        let m; try { m = JSON.parse(raw.toString()) } catch { return }
        if (m.id && this.pending.has(m.id)) {
          const { resolve, reject } = this.pending.get(m.id)
          this.pending.delete(m.id)
          m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result ?? {})
        }
      })
    })
  }

  // 注意：**故意不做心跳保活**。曾经加过 8 秒一次的 Browser.getVersion，
  // 会持续打浏览器。代价是空闲久了连接可能被 Chrome 关掉，下一次请求要多花
  // 一两秒重连 —— 对一次性 API 来说完全可以接受。


  /**
   * 建立连接。**只尝试一次，失败就抛错，绝不自动重试。**
   *
   * 血的教训：Chrome 155 对**每一个新的 DevTools 连接**都会弹「允许调试」授权框。
   * 之前的代码在失败时重试 5 次、每次 API 调用再来一轮 —— 结果就是疯狂弹框，
   * 用户被迫点了七八次「允许」，还不知道自己在点什么。
   * 所以现在：连不上就报错，让人来决定什么时候重试（POST /api/reconnect）。
   */
  async ensure() {
    if (this.connected && this.sid) return this.sid
    await this.connect()
    const { targetInfos } = await this.send('Target.getTargets')
    const t = targetInfos.find(x => x.type === 'page' && x.url.includes('doubao.com/chat'))
      || targetInfos.find(x => x.type === 'page' && x.url.includes('doubao.com'))
    if (!t) throw new Error('没找到豆包页面（请确认 Chrome 里开着 doubao.com/chat）')
    const { sessionId } = await this.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })
    await this.send('Runtime.enable', {}, sessionId)
    this.sid = sessionId
    this.startKeepalive()   // 连上就心跳，尽量让它别再掉（每掉一次就要你再点一次「允许」）
    return sessionId
  }

  /**
   * 心跳：只发协议级无害请求 Browser.getVersion，**不碰豆包页面**。
   * 与之前删掉的「每秒轮询页面状态」是两回事：那个要读 DOM、会打扰页面；
   * 这个纯粹是为了不让 DevTools 连接空闲被回收 —— 因为每重连一次，
   * Chrome 就会弹一次「允许调试」。
   */
  startKeepalive() {
    if (this.keep) return
    this.keep = setInterval(async () => {
      if (!this.connected) return
      try { await this.send('Browser.getVersion') } catch {}
    }, 15000)
    this.keep.unref?.()
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 超时`)) }, 15000)
      this.pending.set(id, { resolve: v => { clearTimeout(t); resolve(v) }, reject: e => { clearTimeout(t); reject(e) } })
      const msg = { id, method, params }
      if (sessionId) msg.sessionId = sessionId
      this.ws.send(JSON.stringify(msg))
    })
  }

  async evaluate(expr) {
    const sid = await this.ensure()
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid)
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result?.value
  }

  /** 挂起式求值：expression 返回 Promise，这条 CDP 请求会一直等着它 resolve。
   *  期间**不发任何请求** —— 靠页面里的 MutationObserver 被动等，不是轮询。 */
  async evaluateWait(expr, timeoutMs = 45000) {
    const sid = await this.ensure()
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('等待超时')) }, timeoutMs)
      this.pending.set(id, {
        resolve: v => { clearTimeout(t); resolve(v.result?.value) },
        reject: e => { clearTimeout(t); reject(e) },
      })
      this.ws.send(JSON.stringify({
        id, sessionId: sid,
        method: 'Runtime.evaluate',
        params: { expression: expr, returnByValue: true, awaitPromise: true },
      }))
    })
  }

  async mouse(type, x, y, modifiers = 0) {
    const sid = await this.ensure()
    await this.send('Input.dispatchMouseEvent', {
      type, x: Math.round(x), y: Math.round(y),
      button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1, modifiers,
    }, sid)
  }

  async clickAt(x, y) {
    await this.mouse('mouseMoved', x, y)
    await this.mouse('mousePressed', x, y)
    await this.mouse('mouseReleased', x, y)
  }

  async centerOf(selector) {
    return this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: r.x + r.width/2, y: r.y + r.height/2 };
    })()`)
  }

  /** modifiers 位掩码：1=Alt 2=Ctrl 4=Meta 8=Shift */
  async key(type, key, code, vk, { text = '', modifiers = 0 } = {}) {
    const sid = await this.ensure()
    const base = {
      key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      modifiers, autoRepeat: false, isKeypad: false, isSystemKey: false, location: 0,
    }
    // ⚠️ keyDown 必须带 text，否则不产生 DOM keydown（rawKeyDown 实测收不到）
    const p = type === 'keyDown' ? { type: 'keyDown', text, unmodifiedText: text, ...base } : { type: 'keyUp', ...base }
    await this.send('Input.dispatchKeyEvent', p, sid)
  }

  spaceDown() { return this.key('keyDown', ' ', 'Space', 32, { text: ' ' }) }
  spaceUp() { return this.key('keyUp', ' ', 'Space', 32) }
}

const cdp = new Cdp()

// ---------------- 页面探测 ----------------
const STATE_JS = `(() => {
  const brief = (s, n=1000) => (s||'').replace(/\\s+/g,' ').trim().slice(0,n);
  const ce = document.querySelector('[contenteditable="true"]');
  const overlay = [...document.querySelectorAll('[class*="asr-overlay"]')]
    .filter(e => { const r = e.getBoundingClientRect(); return r.width>0 && r.height>0; });
  return {
    text: ce ? brief(ce.innerText || ce.textContent, 1000) : null,
    focused: ce ? (document.activeElement === ce || ce.contains(document.activeElement)) : false,
    recording: overlay.length > 0,
  };
})()`

// 录音浮层上的「发送」图标 —— 这就是停止键。
// 实测：点它 recording 从 True 变 False。位置 888,435 32x32，class 带
// asr-overlay-tab-content-send-<hash>（hash 每次构建会变，所以只匹配前缀）。
/**
 * 直接对元素派发一整套鼠标事件。
 *
 * ⚠️ 两个坑，都是实测踩出来的：
 *
 * 1) 不能用坐标点击 Input.dispatchMouseEvent —— 输入框右侧那块区域最上层盖着
 *    一个 `absolute inset-0` 的悬停触发器（data-trigger-type="hover"），
 *    坐标点击会被它吃掉，按钮根本收不到。
 *
 * 2) **必须先派发 hover 事件**（pointerover/pointerenter/mouseover/mouseenter/
 *    pointermove/mousemove）再点，否则按钮不响应。
 *    实测：只发 down/up/click → recording 仍为 False；
 *          前面补上 hover 序列 → recording 立刻变 True。
 */
function clickElJs(finderBody) {
  return `(() => {
    ${finderBody}
    const fire = (el) => {
      const b = el.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, composed: true, view: window,
                  clientX: Math.round(b.x + b.width/2), clientY: Math.round(b.y + b.height/2),
                  button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      const seq = ['pointerover','pointerenter','mouseover','mouseenter','pointermove','mousemove',
                   'pointerdown','mousedown','pointerup','mouseup','click'];
      for (const t of seq) {
        try { el.dispatchEvent(new (t.indexOf('pointer') === 0 ? PointerEvent : MouseEvent)(t, o)) }
        catch (e) { el.dispatchEvent(new MouseEvent(t.replace('pointer','mouse'), o)) }
      }
      return Math.round(b.x) + ',' + Math.round(b.y) + ' (' + Math.round(b.width) + 'x' + Math.round(b.height) + ')';
    };
    if (!el) return { err: why || '没找到元素' };
    return { ok: true, at: fire(el), cls: String(el.className).slice(0, 70) };
  })()`
}

// 麦克风按钮：空闲时在最右边，点它开始录音。要求 class 带 hover/cursor-pointer/bg-dbx
// —— 因为同一个位置叠了 3 个 size-36 的 div，只有最里面那个才是真正响应点击的。
const CLICK_MIC_JS = clickElJs(`
  const ce = document.querySelector('[contenteditable="true"]');
  if (!ce) return { err: '没有输入框' };
  const r = ce.getBoundingClientRect();
  const cands = [...document.querySelectorAll('div,button')].filter(x => {
    if (x.closest('[class*="asr-overlay"]')) return false;
    const c = typeof x.className === 'string' ? x.className : '';
    if (!/size-36/.test(c)) return false;
    if (!/hover:|cursor-pointer|bg-dbx/.test(c)) return false;
    const b = x.getBoundingClientRect();
    return b.width > 0 && b.height > 0 && b.y > r.y - 80 && b.y < r.y + 120 && b.x > r.x + r.width - 40;
  });
  const el = cands[0];
  const why = '输入框右侧没找到麦克风按钮';
`)

// 浮层上的发送图标 —— 这就是停止键（实测点它 recording 从 True 变 False）
const CLICK_OVERLAY_SEND_JS = clickElJs(`
  const el = document.querySelector('[class*="asr-overlay-tab-content-send"]');
  const why = '浮层上没有发送图标（是不是没在录音？）';
`)

/** 点麦克风按钮（开始录音） */
async function clickMicOnce() {
  const r = await cdp.evaluate(CLICK_MIC_JS)
  if (!r || r.err) return { ok: false, why: r ? r.err : '未知错误' }
  return { ok: true, at: r.at, cls: r.cls }
}

/** 点浮层上的发送图标（停止录音） */
async function clickOverlaySend() {
  const r = await cdp.evaluate(CLICK_OVERLAY_SEND_JS)
  if (!r || r.err) return { ok: false, why: r ? r.err : '未知错误' }
  return { ok: true, at: r.at }
}

// ---------------- 全局互斥锁 ----------------
/**
 * 会改动豆包页面状态的操作共用一把锁：
 *   rec/start、rec/stop、clear、debug、reconnect
 *
 * 语义是**快速失败**，不是排队。理由：
 *   rec/stop 最长持锁 30 秒（在等识别文字）。如果让后面的请求排队，
 *   一个 30 秒前发出的 clear 会在 stop 结束、文字已经取走之后才执行 ——
 *   结果过期，比直接报错更糟。调用方拿到 busy 后自己决定要不要重试。
 *
 * 故意**不上锁**的接口：
 *   POST /api/rec/release   卡住时的紧急出口，任何时候都必须能用
 *   GET  /api/state         只读（只额外附带当前锁的持有者）
 *   POST /api/grantmic      只改浏览器权限，不碰页面
 *   POST /api/eval          调试用只读求值
 */
let lockHolder = null

/** 取锁。拿不到返回 { ok:false, error:'busy', busyWith, msg } */
function acquire(name) {
  if (lockHolder) {
    return { ok: false, error: 'busy', busyWith: lockHolder, msg: `正在执行 ${lockHolder}，请等它结束后重试` }
  }
  lockHolder = name
  let done = false
  return {
    ok: true,
    release() { if (!done) { done = true; if (lockHolder === name) lockHolder = null } },
  }
}

/** 自动取锁/释放；拿不到锁就返回 busy 对象，不排队 */
async function withLock(name, fn) {
  const g = acquire(name)
  if (!g.ok) return g
  try { return await fn() } finally { g.release() }
}

// ---------------- 动作 ----------------

async function recStart() {
  const g = acquire('rec/start')
  if (!g.ok) return g
  try {
    // 点输入框右侧那个按钮（空闲时它是麦克风图标）开始录音。
    // 实测这一个按钮是「开/关」切换：空闲点→开始录音，录音中点→停止。
    //
    // 为什么不用「按住空格」：keyUp 实测**停不下来**（发完 recording 仍为 True），
    // 会一直卡在录音态；而点击这个按钮开、关都可靠。
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await clickMicOnce()
      if (!r.ok) return { ok: false, error: 'no_button', msg: r.why }
      await sleep(900)
      const st = await cdp.evaluate(STATE_JS)
      if (st.recording) return { ok: true, msg: '🎙 录音中' }
    }
    return { ok: false, error: 'not_recording', msg: '点了麦克风但没进入录音状态' }
  } finally { g.release() }
}

/**
 * 等识别文字出现的「挂起式」脚本。
 * 用 MutationObserver 监听输入框，文字出现并稳定 700ms 就 resolve。
 * 这条表达式作为 Promise 交给 Runtime.evaluate(awaitPromise)，整段时间零请求。
 */
const WAIT_TEXT_JS = `new Promise(resolve => {
  const read = () => {
    const ce = document.querySelector('[contenteditable="true"]');
    return ce ? (ce.innerText || ce.textContent || '').replace(/\\s+/g,' ').trim() : '';
  };
  const ce0 = document.querySelector('[contenteditable="true"]');
  if (!ce0) return resolve('');
  let last = read();
  let stableSince = last ? Date.now() : 0;
  const done = t => { try { obs.disconnect() } catch {} ; resolve(t) };
  const obs = new MutationObserver(() => {
    const t = read();
    if (t !== last) { last = t; stableSince = Date.now(); }
    if (t && Date.now() - stableSince > 700) done(t);
  });
  obs.observe(ce0, { childList: true, subtree: true, characterData: true });
  setTimeout(() => done(read()), 20000);   // 兜底
})`

/**
 * 「我发出的消息」气泡的计数。
 *
 * 选择器来自实测 DOM：
 *   <div class="content-KTJ1Rj ... bg-g-send-msg-bubble-bg ...">   ← 发送方气泡专用背景类
 *     <div data-testid="message_text_content">                     ← 稳定的 testid
 *       <div class="container-enLQFx">非常不错， OK。</div>
 *
 * 用 bg-g-send-msg-bubble-bg 就能**精确区分「我发的」和「豆包回的」**，
 * 不需要靠左右对齐之类的启发式（豆包的 class 多是构建哈希，只有这个语义类稳定）。
 */
const SENT_SEL = '[class*="bg-g-send-msg-bubble-bg"]'

/** 读「我发出的最后一条消息」的纯文字 */
const readLastSent = `(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(SENT_SEL)})];
  if (!els.length) return '';
  const box = els[els.length - 1].querySelector('[data-testid="message_text_content"]') || els[els.length - 1];
  return (box.innerText || '').replace(/\\s+/g, ' ').trim();
})()`

const LAST_SENT_JS = readLastSent

/**
 * 挂起等待「我发出的最后一条消息」变成与 prev 不同的新内容，并返回它。
 *
 * ⚠️ 为什么不用「消息条数变多」：豆包的消息列表是**虚拟滚动**的，
 *    只有视口附近的消息留在 DOM 里，滚动时旧消息会被移除 ——
 *    实测条数一直卡在 3，永远等不到"变多"。改成比对**文字内容**才可靠。
 *
 * 作为 Promise 交给 Runtime.evaluate(awaitPromise) —— 等待期间零请求。
 */
const waitNewSentJs = prev => `new Promise(resolve => {
  const read = () => {
    const els = [...document.querySelectorAll(${JSON.stringify(SENT_SEL)})];
    if (!els.length) return '';
    const box = els[els.length - 1].querySelector('[data-testid="message_text_content"]') || els[els.length - 1];
    return (box.innerText || '').replace(/\\s+/g, ' ').trim();
  };
  const prev = ${JSON.stringify(prev)};
  const done = t => { try { obs.disconnect() } catch {} ; resolve(t || '') };
  const check = () => { const t = read(); if (t && t !== prev) done(t) };
  const obs = new MutationObserver(check);
  obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  setTimeout(() => { const t = read(); done(t && t !== prev ? t : '') }, 18000);   // 兜底
  check();
})`

/**
 * 真正结束录音的**唯一可靠办法**：点录音浮层上的「发送」图标，
 * 直到页面退出录音态为止。
 *
 * ⚠️ 为什么不能用别的：
 *   - 补发 Space keyUp —— 实测**停不下来**，发完 recording 仍是 true
 *   - 点输入框右侧那个麦克风按钮 —— 录音时它被浮层盖住，选不中／点了没用
 *   实测只有浮层上这个发送图标能可靠退出录音态。
 */
async function stopRecording() {
  const tries = []
  for (let i = 0; i < 3; i++) {
    const r = await clickOverlaySend()
    tries.push(r)
    if (!r.ok) break
    await sleep(800)
    const st = await cdp.evaluate(STATE_JS)
    if (!st.recording) return { stopped: true, tries }
  }
  return { stopped: false, tries }
}

/**
 * 结束录音并取回识别文字。
 *  1) 点浮层上的发送图标 → 停止录音
 *  2) 等文字出现：先看输入框（有时不发出去），没有就读对话里最后一条用户消息
 */
async function recStop({ clear = true } = {}) {
  const g = acquire('rec/stop')
  if (!g.ok) return g
  try {
    const beforeText = (await cdp.evaluate(LAST_SENT_JS) || '').trim()
    const { stopped, tries } = await stopRecording()
    if (!stopped) {
      return {
        ok: false, error: 'cannot_stop', text: '',
        msg: '点了发送图标但没能退出录音态',
        诊断: { 点击记录: tries },
      }
    }

    // 取文字：优先等「对话里多出一条新消息」（点发送会把文字发出去）；
    // 有些情况文字只落进输入框没发出去，那就读输入框。
    let text = (await cdp.evaluateWait(waitNewSentJs(beforeText), 30000) || '').trim()
    let source = 'chat'
    if (!text) {
      text = ((await cdp.evaluate(STATE_JS)).text || '').trim()
      source = 'input'
    }
    if (!text) {
      return { ok: false, error: 'no_text', text: '', msg: '没拿到文字（没说话 / 麦克风没声？）' }
    }
    if (clear && source === 'input') await clearInput()
    const copied = toClipboard(text)
    return {
      ok: true, text, from: source, clipboard: copied, 上一条: beforeText,
      msg: `识别完成（${text.length} 字，来自${source === 'chat' ? '对话' : '输入框'}）${copied ? '，已复制到剪贴板' : ''}`,
    }
  } finally { g.release() }
}

/**
 * 取消录音：**真正结束录音**，并把已经识别出来的文字丢掉。
 *
 * 和 /api/rec/stop 的区别：
 *   stop   → 结束录音，**返回**文字给你
 *   cancel → 结束录音，**丢弃**文字，只回一个字数
 *
 * 为什么必须有这条：光发 keyUp 结束不了录音（实测 recording 仍为 true），
 * 麦克风会一直录着。用户点「取消」时想要的是「别录了，刚才说的不算」——
 * 那就必须走这个端点，而不是 release。
 */
async function recCancel() {
  const g = acquire('rec/cancel')
  if (!g.ok) return g
  try {
    const st0 = await cdp.evaluate(STATE_JS)
    const wasRecording = !!(st0 && st0.recording)

    // 本来就没在录 → 目的已经达到，不需要点任何东西。
    // （早先这里无条件去点发送图标，点不到就报 cannot_stop，
    //   于是「没在录时取消」反而返回失败 —— 逻辑错了。）
    let stopped = true
    let tries = []
    if (wasRecording) {
      const r = await stopRecording()
      stopped = r.stopped
      tries = r.tries
    }

    // 停下来之后，把落进输入框的文字清掉。
    // 只在真的录过音时才清 —— 否则会误删用户自己敲的内容。
    let discarded = 0
    if (wasRecording) {
      try {
        const st = await cdp.evaluate(STATE_JS)
        discarded = st && typeof st.text === 'string' ? st.text.length : 0
        if (discarded > 0) await clearInput()
      } catch (error) {
        /* 清不掉不影响「录音已停止」这个结论 */
      }
    }

    let recording = true
    try { recording = !!(await cdp.evaluate(STATE_JS)).recording } catch (error) { /* 忽略 */ }

    return {
      ok: stopped,
      error: stopped ? undefined : 'cannot_stop',
      wasRecording,
      discarded,
      recording,
      msg: stopped
        ? (wasRecording ? `已结束录音，丢弃 ${discarded} 字` : '本来就没在录音，已确认停止')
        : '点了发送图标但没能退出录音态',
      ...(stopped ? {} : { 诊断: { 点击记录: tries } }),
    }
  } finally { g.release() }
}

/** 清空输入框：点进去 → Ctrl+A → Delete。用真实按键而不是 innerHTML，
 *  避免 ProseMirror 内部状态和 DOM 不一致。 */
async function clearInput(force = false) {
  const c = await cdp.centerOf('[contenteditable="true"]')
  if (!c) throw new Error('找不到输入框')
  await cdp.clickAt(c.x, c.y)
  await sleep(120)
  await cdp.key('keyDown', 'a', 'KeyA', 65, { text: 'a', modifiers: 2 })  // 2 = Ctrl
  await cdp.key('keyUp', 'a', 'KeyA', 65, { modifiers: 2 })
  await sleep(80)
  await cdp.key('keyDown', 'Delete', 'Delete', 46, {})
  await cdp.key('keyUp', 'Delete', 'Delete', 46, {})
  await sleep(150)
  const st = await cdp.evaluate(STATE_JS)
  return { ok: true, text: st.text || '' }
}

// ---------------- HTTP ----------------
const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>豆包语音转文字 · API</title>
<style>
  body{font-family:-apple-system,"Microsoft YaHei",sans-serif;background:#111;color:#eee;margin:0;
       padding:24px;display:flex;flex-direction:column;gap:14px;align-items:center}
  h1{font-size:17px;font-weight:500;color:#999;margin:0}
  button{width:340px;padding:18px;font-size:19px;border:0;border-radius:12px;cursor:pointer;
         color:#fff;background:#2a2a2e;transition:.15s}
  button:hover{background:#3a3a40}button:active{transform:scale(.98)}
  #rec{background:#c0392b}#stop{background:#1f6feb}
  #out{width:560px;min-height:150px;background:#0d1a10;border:1px solid #2f7d4f;border-radius:10px;
       padding:18px;font-size:24px;line-height:1.7;white-space:pre-wrap;word-break:break-word;
       color:#d8ffe4;user-select:text;cursor:text}
  #out.empty{color:#555;font-size:15px;border-color:#333;background:#1a1a1d}
  #copy{background:#2f7d4f;width:560px}
  #hist{width:560px;font-size:13px;color:#888;line-height:1.8;max-height:150px;overflow:auto}
  #hist div{border-top:1px solid #262629;padding:5px 0}
</style></head><body>
<h1>豆包语音转文字 · API 服务</h1>
<button id="rec">🎙 开始录音</button>
<button id="stop">⏹ 结束录音并取文字</button>
<button id="refresh" style="background:#333;font-size:15px;padding:12px">↻ 刷新状态（不自动轮询）</button>
<div id="out" class="empty">（识别结果会显示在这里，大字、可直接选中复制）</div>
<button id="copy">📋 复制这段文字</button>
<div id="hist"></div>
<div id="stat">就绪</div>
<div style="font-size:12px;color:#666;text-align:center;line-height:1.9">
  别的系统直接调 API：<br>
  <code>POST /api/rec/start</code> &nbsp; <code>POST /api/rec/stop</code> → <code>{ ok, text }</code><br>
  <br>
  <b style="color:#8ab4f8">给 AI / 调用方看的接口说明：</b><br>
  <a href="/api" style="color:#8ab4f8">GET /api</a> &nbsp;·&nbsp;
  <a href="/openapi.json" style="color:#8ab4f8">GET /openapi.json</a><br>
  <span style="color:#555">把这个服务的地址直接丢给 AI，它读 / 就能拿到完整说明</span>
</div>
<script>
const out = document.getElementById('out'), stat = document.getElementById('stat'), hist = document.getElementById('hist');
function show(t) {
  out.textContent = t;
  out.classList.remove('empty');
  const d = document.createElement('div');
  d.textContent = new Date().toLocaleTimeString() + '  ' + t;
  hist.prepend(d);
}
const call = async (p, label) => {
  stat.textContent = label + ' …';
  try {
    const j = await (await fetch(p, {method:'POST'})).json();
    if (j.text) show(j.text);
    stat.textContent = j.msg || (j.ok ? 'OK' : '失败');
  } catch (e) { stat.textContent = '请求失败: ' + e.message; }
};
document.getElementById('rec').onclick  = () => call('/api/rec/start','开始录音');
document.getElementById('stop').onclick = () => call('/api/rec/stop','结束录音');
document.getElementById('copy').onclick = async () => {
  const t = out.textContent || '';
  if (!t) return;
  try { await navigator.clipboard.writeText(t); stat.textContent = '✓ 已复制到剪贴板'; }
  catch { const r = document.createRange(); r.selectNodeContents(out);
          const s = getSelection(); s.removeAllRanges(); s.addRange(r);
          stat.textContent = '请按 Ctrl+C（已帮你选中）'; }
};
document.getElementById('refresh').onclick = async () => {
  try { const j = await (await fetch('/api/state')).json();
    stat.textContent = (j.recording?'🔴 录音中':'⚪ 空闲') + ' | 输入框 ' + ((j.text||'').length) + ' 字';
    if (j.text) show(j.text);
  } catch (e) { stat.textContent = '失败: ' + e.message; }
};
</script></body></html>`

/**
 * 给调用方（尤其是 AI）读的自描述文档。GET /api 返回它。
 *
 * 设计意图：把服务地址丢给一个 AI，它读这一个端点就能自己把接口用起来，
 * 不需要额外的文档文件。所以这里必须**自包含**：端点、请求、响应、错误码、
 * 超时、并发约束、部署形态，全都写全。
 */
const docText = () => `# 豆包语音转文字 API (Doubao Speech-to-Text)  v1

把麦克风里说的话转成文字。本服务驱动一个真实的豆包网页做识别，
对外只暴露下面这些 HTTP 接口。本文档由服务自己生成，照此调用即可。

Base URL : http://${BIND}:${HTTP_PORT}
OpenAPI  : http://${BIND}:${HTTP_PORT}/openapi.json
状态页   : http://${BIND}:${HTTP_PORT}/   (浏览器打开)

═══════════════════════════════════════════════════════════════
30 秒上手
═══════════════════════════════════════════════════════════════

    curl -X POST http://${BIND}:${HTTP_PORT}/api/rec/start
    #  现在对着麦克风说话
    curl -X POST http://${BIND}:${HTTP_PORT}/api/rec/stop
    #  -> {"ok":true,"text":"识别出来的文字"}

═══════════════════════════════════════════════════════════════
端点总表
═══════════════════════════════════════════════════════════════

方法  路径                 作用                      耗时      占锁
POST  /api/rec/start       开始录音                  1~3 秒    是
POST  /api/rec/stop        结束录音并返回文字 ★      2~30 秒   是
POST  /api/rec/cancel      取消：结束录音并丢弃文字  1~4 秒    是
GET   /api/state           查询当前状态              <1 秒     否
POST  /api/clear           清空输入框                <1 秒     是
POST  /api/rec/release     底层松手（不保证停录）    <1 秒     否
POST  /api/grantmic        授予麦克风权限            <1 秒     否
POST  /api/reconnect       重连浏览器                1~40 秒   是
POST  /api/eval            调试：页面里求值 JS       —         否
POST  /api/debug           调试：单步动作            —         是

───────────────────────────────────────────────────────────────
POST /api/rec/start  —  开始录音
───────────────────────────────────────────────────────────────
请求体: 无

成功:   {"ok":true,"msg":"🎙 录音中"}
失败:   {"ok":false,"error":"busy"|"no_button"|"not_recording","msg":"..."}

───────────────────────────────────────────────────────────────
POST /api/rec/stop  —  结束录音并取回文字   ★ 主要接口
───────────────────────────────────────────────────────────────
请求体: 无

成功:   {"ok":true,
         "text":"识别出来的文字",         ← 你要的就是这个
         "from":"chat"|"input",           ← 文字是从对话气泡还是输入框取的
         "clipboard":true,                ← 是否已写进本机剪贴板
         "上一条":"上一次的结果",
         "msg":"识别完成（24 字，来自对话）"}

失败:   {"ok":false,"error":"busy"|"cannot_stop"|"no_text","text":"","msg":"..."}

⚠️ 内部最长等 30 秒。HTTP 客户端超时请设 45 秒以上，否则会在服务端
   还在等识别结果时先断开。

───────────────────────────────────────────────────────────────
GET /api/state  —  当前状态
───────────────────────────────────────────────────────────────
返回:   {"text":"",           ← 输入框当前内容（截断 1000 字）
         "focused":true,      ← 输入框是否聚焦
         "recording":false,   ← 是否正在录音
         "busy":null}         ← 当前占锁的操作名，null = 空闲

注意: 这个方法没做方法校验，GET / POST 都能用。

───────────────────────────────────────────────────────────────
POST /api/clear  —  清空输入框
───────────────────────────────────────────────────────────────
返回:   {"ok":true,"text":""}

───────────────────────────────────────────────────────────────
POST /api/rec/cancel  —  取消录音：结束录音 + 丢弃文字
───────────────────────────────────────────────────────────────
请求体: 无

用户点「取消」时用这条 —— 想要的是「别录了，刚才说的不算」。

成功:   {"ok":true,
         "wasRecording":true,     ← 调用前是否真的在录
         "discarded":12,          ← 丢掉了多少字
         "recording":false,       ← 调用后是否还在录（必须是 false）
         "msg":"已结束录音，丢弃 12 字"}

失败:   {"ok":false,"error":"cannot_stop","recording":true,"msg":"..."}

和 /api/rec/stop 的区别: stop 返回文字，cancel 丢弃文字。

───────────────────────────────────────────────────────────────
POST /api/rec/release  —  底层松手（⚠️ 不保证结束录音）
───────────────────────────────────────────────────────────────
只补发一次 Space keyUp。**不占锁**，任何时候都能调。

⚠️ 实测豆包的语音输入在 CDP 下发 keyUp 之后 recording 仍然是 true ——
   也就是说**这个端点通常停不掉录音**。它只作底层兜底，
   并且会如实汇报：真没停就返回 ok:false。

要真正停止录音，请用 POST /api/rec/cancel。

返回:   {"ok":false,
         "stopped":false,
         "state":{"text":"","focused":true,"recording":true},
         "msg":"补发了 keyUp，但录音没有停止（这是已知行为）。请改用 POST /api/rec/cancel"}

───────────────────────────────────────────────────────────────
POST /api/grantmic  —  授予麦克风权限
───────────────────────────────────────────────────────────────
新环境第一次部署时调一次，否则点了麦克风也进不了录音态。
返回:   {"ok":true,"msg":"已授予麦克风权限","当前权限":"granted"}

───────────────────────────────────────────────────────────────
POST /api/reconnect  —  重连浏览器
───────────────────────────────────────────────────────────────
浏览器关掉或卡住时用。会触发一次浏览器「允许调试」授权框，需要人工点允许。
返回:   {"ok":true,"msg":"✓ CDP 已连接"}
        {"ok":false,"msg":"连接失败：..."}

───────────────────────────────────────────────────────────────
POST /api/eval   —  调试：在豆包页面里求值 JS 表达式
POST /api/debug  —  调试：单步动作
                     body: {"action":"clickmic"|"clicksend"|"keydown"|
                                    "keyup"|"click"|"evalclick",
                            "x":0,"y":0,"sel":"选择器","wait":1500}
───────────────────────────────────────────────────────────────

═══════════════════════════════════════════════════════════════
错误码
═══════════════════════════════════════════════════════════════

error           含义                    怎么处理
busy            有别的操作正在跑        读 busyWith，等 1 秒重试
no_text         没识别到内容            让用户重说
not_recording   没进入录音态            检查麦克风权限 → POST /api/grantmic
cannot_stop     停不下来                调 POST /api/rec/release
no_button       豆包页面异常            确认浏览器里开着豆包且已登录
exception       服务内部异常            看 msg
unknown_route   路径写错了              对照上面的端点表

═══════════════════════════════════════════════════════════════
必须知道的三件事
═══════════════════════════════════════════════════════════════

1) 不要并发调用。
   所有会改动页面状态的操作共用一把互斥锁，撞上直接返回 busy（快速失败，不排队）。
     占锁: rec/start, rec/stop, rec/cancel, clear, debug, reconnect
     不占锁: rec/release, state, grantmic, eval
   拿不到锁时响应里带 busyWith，告诉你谁占着。

2) /api/rec/stop 最长要等 30 秒（在等识别结果）。
   HTTP 客户端超时设 45 秒以上。不要自动重试 —— 重试只会拿到 no_text。

3) 停止录音只有一条可靠路径：点录音浮层上的「发送」图标。
   补发 keyUp（/api/rec/release）实测停不下来。所以：
     要文字 → /api/rec/stop
     不要文字（取消）→ /api/rec/cancel
   release 只作底层兜底，且会在 ok 字段里如实告诉你有没有停成功。

4) 跨源调用没问题。
   本服务返回 Access-Control-Allow-Origin: *，
   浏览器页面可以直接 fetch，不需要代理。

═══════════════════════════════════════════════════════════════
部署形态与启停
═══════════════════════════════════════════════════════════════

本服务依赖一个开着豆包网页的独立 Chrome，两者缺一不可:

  Chrome 调试端口  9223   专用配置目录，与日常浏览器完全隔离
  本服务端口       ${HTTP_PORT}

启动 (幂等，已在跑就跳过):
  C:\\Users\\luizs\\OBA-tools\\doubao-stt\\serve.cmd

停止 (只杀上面这两个，不会碰日常浏览器):
  C:\\Users\\luizs\\OBA-tools\\doubao-stt\\stop.cmd

已注册开机自启，正常不用手动管。

从别的机器访问:
  默认只监听 127.0.0.1。三种办法:
    a) SSH 隧道:  ssh -N -L ${HTTP_PORT}:127.0.0.1:${HTTP_PORT} <user>@<host>
    b) 服务端设 DOUBAO_BIND=0.0.0.0 并放行防火墙（无认证，仅限可信局域网）
    c) 把调用方也跑在本机

排查:
  curl http://${BIND}:${HTTP_PORT}/api/state
  正常返回 {"text":"","focused":true,"recording":false,"busy":null}
  连不上 → 跑 serve.cmd
  一直 no_text → POST /api/grantmic
`

/** 标准 OpenAPI 3.1 描述。GET /openapi.json 返回它。 */
const openapiSpec = () => ({
  openapi: '3.1.0',
  info: {
    title: '豆包语音转文字 API',
    version: '1.0.0',
    description: '把麦克风里说的话转成文字。底层驱动一个真实的豆包网页做识别。',
  },
  servers: [{ url: `http://${BIND}:${HTTP_PORT}` }],
  paths: {
    '/api/rec/start': {
      post: {
        summary: '开始录音',
        operationId: 'recStart',
        responses: {
          200: {
            description: '已开始录音，或带有 error 字段的失败说明',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/GenericResult' } } },
          },
        },
      },
    },
    '/api/rec/stop': {
      post: {
        summary: '结束录音并返回识别文字（最长阻塞 30 秒）',
        operationId: 'recStop',
        responses: {
          200: {
            description: '识别结果',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/StopResult' } } },
          },
        },
      },
    },
    '/api/state': {
      get: {
        summary: '当前状态',
        operationId: 'getState',
        responses: {
          200: {
            description: '状态快照',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/State' } } },
          },
        },
      },
    },
    '/api/rec/cancel': {
      post: {
        summary: '取消录音：真正结束录音并丢弃已识别的文字',
        operationId: 'recCancel',
        responses: {
          200: {
            description: '已结束录音；discarded 为丢弃的字数',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/GenericResult' } } },
          },
        },
      },
    },
    '/api/clear': {
      post: {
        summary: '清空输入框',
        operationId: 'clearInput',
        responses: { 200: { description: '已清空', content: { 'application/json': { schema: { $ref: '#/components/schemas/GenericResult' } } } } },
      },
    },
    '/api/rec/release': {
      post: {
        summary: '底层松手：补发一次 keyUp（实测不保证结束录音，请改用 /api/rec/cancel）',
        operationId: 'release',
        responses: { 200: { description: '包含 stopped 字段，如实反映有没有停成功', content: { 'application/json': { schema: { $ref: '#/components/schemas/GenericResult' } } } } },
      },
    },
    '/api/grantmic': {
      post: {
        summary: '授予麦克风权限',
        operationId: 'grantMic',
        responses: { 200: { description: '已授权', content: { 'application/json': { schema: { $ref: '#/components/schemas/GenericResult' } } } } },
      },
    },
    '/api/reconnect': {
      post: {
        summary: '重连浏览器（会触发一次授权框）',
        operationId: 'reconnect',
        responses: { 200: { description: '连接结果', content: { 'application/json': { schema: { $ref: '#/components/schemas/GenericResult' } } } } },
      },
    },
  },
  components: {
    schemas: {
      GenericResult: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          error: { type: 'string', description: 'busy | no_text | not_recording | cannot_stop | no_button | exception | unknown_route' },
          busyWith: { type: 'string', description: 'error=busy 时，当前占锁的操作名' },
          msg: { type: 'string', description: '给人看的中文说明' },
        },
        required: ['ok'],
      },
      StopResult: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string', description: '识别出来的文字' },
          from: { type: 'string', enum: ['chat', 'input'], description: '文字取自对话气泡还是输入框' },
          clipboard: { type: 'boolean', description: '是否已写入本机剪贴板' },
          msg: { type: 'string' },
        },
        required: ['ok'],
      },
      State: {
        type: 'object',
        properties: {
          text: { type: ['string', 'null'], description: '输入框当前内容' },
          focused: { type: 'boolean' },
          recording: { type: 'boolean' },
          busy: { type: ['string', 'null'], description: '占锁的操作名，null = 空闲' },
        },
      },
    },
  },
})

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}
const json = (res, obj, code = 200) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...cors })
  res.end(JSON.stringify(obj))
}

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0]
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end() }
  try {
    // 根路径做内容协商：
    //   浏览器（Accept: text/html）→ 状态页
    //   curl / fetch / AI          → 自描述文档
    // 这样「把地址丢给一个 AI」就能直接用，不需要先告诉它去哪拿文档。
    if (req.method === 'GET' && url === '/') {
      const accept = String(req.headers.accept || '')
      if (accept.includes('text/html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...cors })
        return res.end(PAGE)
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', ...cors })
      return res.end(docText())
    }
    // 自描述文档（给 AI / 调用方读）
    if (req.method === 'GET' && (url === '/api' || url === '/llms.txt' || url === '/docs')) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', ...cors })
      return res.end(docText())
    }
    // 标准 OpenAPI 描述
    if (req.method === 'GET' && (url === '/openapi.json' || url === '/api/openapi.json')) {
      return json(res, openapiSpec())
    }
    if (url === '/api/state') {
      const st = await cdp.evaluate(STATE_JS)
      return json(res, { ...st, busy: lockHolder })
    }
    if (req.method === 'POST' && url === '/api/rec/start') return json(res, await recStart())
    if (req.method === 'POST' && url === '/api/rec/stop') return json(res, await recStop())
    if (req.method === 'POST' && url === '/api/clear') {
      return json(res, await withLock('clear', () => clearInput(true)))
    }
    if (req.method === 'POST' && url === '/api/rec/cancel') {
      // 真正结束录音 + 丢弃文字。取消操作请用这条，不要用 release。
      return json(res, await recCancel())
    }
    if (req.method === 'POST' && url === '/api/rec/release') {
      // 底层松手：补发一次 Space keyUp。
      //
      // ⚠️ 实测**不保证结束录音** —— 豆包的语音输入在 CDP 下发 keyUp 之后
      //    recording 仍然是 true。所以这里只当底层兜底用，并且**如实汇报**：
      //    真的没停就把 ok 置 false 并在 msg 里指向 /api/rec/cancel。
      //    （早先这个端点无条件回 ok:true，是错的。）
      await cdp.spaceUp()
      await sleep(800)
      const state = await cdp.evaluate(STATE_JS)
      return json(res, {
        ok: !state.recording,
        stopped: !state.recording,
        state,
        msg: state.recording
          ? '补发了 keyUp，但录音没有停止（这是已知行为）。请改用 POST /api/rec/cancel'
          : '已停止录音',
      })
    }
    if (req.method === 'POST' && url === '/api/debug') {
      // 调试用：分开测单个动作，定位到底哪一步失效
      return json(res, await withLock('debug', async () => {
        let body = ''
        for await (const c of req) body += c
        const p = JSON.parse(body || '{}')
        const before = await cdp.evaluate(STATE_JS)
        let note = ''
        if (p.action === 'keydown') { await cdp.spaceDown(); note = 'spaceDown' }
        else if (p.action === 'keyup') { await cdp.spaceUp(); note = 'spaceUp' }
        else if (p.action === 'clickmic') { const r = await clickMicOnce(); note = JSON.stringify(r) }
        else if (p.action === 'clicksend') { const r = await clickOverlaySend(); note = JSON.stringify(r) }
        else if (p.action === 'click') {
          await cdp.clickAt(p.x, p.y); note = `坐标点了 ${p.x},${p.y}`
        }
        else if (p.action === 'evalclick') {
          // 对选择器命中的元素直接派发鼠标事件（绕开覆盖层）
          const r = await cdp.evaluate(clickElJs(`
            const el = document.querySelector(${JSON.stringify(p.sel || 'body')});
            const why = '找不到 ' + ${JSON.stringify(p.sel || 'body')};
          `))
          note = JSON.stringify(r)
        }
        await sleep(p.wait ?? 1500)
        return { ok: true, note, before, after: await cdp.evaluate(STATE_JS) }
      }))
    }
    if (req.method === 'POST' && url === '/api/reconnect') {
      // 手动重连。每次重连 Chrome 都会弹一次「允许调试」，所以**只在人要求时才做**。
      // 必须上锁：重连会拆掉 WebSocket，如果此刻正在录音或等识别结果就是灾难。
      return json(res, await withLock('reconnect', async () => {
        try {
          try { cdp.ws?.terminate() } catch {}
          cdp.connected = false; cdp.sid = null
          await cdp.ensure()
          return { ok: true, msg: '✓ CDP 已连接' }
        } catch (e) {
          return { ok: false, msg: `连接失败：${e.message}。Chrome 里如果弹了「允许调试」，点允许后再试一次。` }
        }
      }))
    }
    if (req.method === 'POST' && url === '/api/grantmic') {
      // 给豆包授予麦克风权限。
      // 为什么需要：全新的 Chrome 配置目录从没授权过，navigator.permissions 是
      // "prompt"，此时 getUserMedia 起不来 → 点了麦克风也进不了录音态（实测）。
      await cdp.send('Browser.grantPermissions', {
        origin: 'https://www.doubao.com',
        permissions: ['audioCapture'],
      })
      const st = await cdp.evaluate(`navigator.permissions.query({name:'microphone'}).then(p => p.state)`)
      return json(res, { ok: true, msg: '已授予麦克风权限', 当前权限: st })
    }
    if (req.method === 'POST' && url === '/api/eval') {
      // 调试用：body 里放 JS 表达式，直接求值
      let body = ''
      for await (const c of req) body += c
      return json(res, { ok: true, result: await cdp.evaluate(body) })
    }
    json(res, { ok: false, error: 'unknown_route' }, 404)
  } catch (e) {
    log('API 错误: ' + e.message)
    json(res, { ok: false, error: 'exception', msg: e.message }, 500)
  }
}).listen(HTTP_PORT, BIND, async () => {
  console.log(`API 服务已启动： http://${BIND}:${HTTP_PORT}`)
  console.log('  POST /api/rec/start   开始录音')
  console.log('  POST /api/rec/stop    结束录音 → { ok, text }')
  console.log('')
  console.log('正在连接 Chrome —— 如果 Chrome 弹出「允许调试」，请点允许（只需这一次）…')
  try {
    await cdp.ensure()
    console.log('✓ 已连上豆包页面。连接会用心跳保持，正常情况下不会再弹框。')
  } catch (e) {
    console.log('✗ 连接失败：' + e.message)
    console.log('  → 在 Chrome 点「允许」后执行：curl -X POST http://127.0.0.1:' + HTTP_PORT + '/api/reconnect')
  }
})
