const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const source = fs.readFileSync(path.join(__dirname, '..', 'preload.cjs'), 'utf8')

function preload({ origin = 'https://127.0.0.1:13443', mainFrame = true } = {}) {
  const listeners = new Map()
  const messages = []
  const windowActions = []
  const commands = new Map()
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.events = new Map(); this.style = {}; this.attributes = {} }
    append(...children) { this.children.push(...children) }
    setAttribute(name, value) { this.attributes[name] = value }
    addEventListener(type, handler) { this.events.set(type, handler) }
    attachShadow() { this.shadow = new Element('shadow'); return this.shadow }
  }
  const document = { readyState: 'complete', documentElement: new Element('html'),
    createElement: tag => new Element(tag) }
  class Socket extends EventEmitter {
    constructor(url) { super(); this.url = url }
    addEventListener(name, handler) { this.on(name, handler) }
  }
  const window = { location: { origin }, WebSocket: Socket,
    addEventListener(type, handler) { listeners.set(type, handler) },
    postMessage(data, origin) { listeners.get('message')?.({ source: window, origin, data }) } }
  const mainContext = vm.createContext({ window, URL })
  vm.runInNewContext(source, { window, document, process: { isMainFrame: mainFrame },
    require(name) {
      assert.equal(name, 'electron')
      return { ipcRenderer: {
        send(channel, value) {
          if (channel === 'oba-voice-window-action') windowActions.push(value)
          else { assert.equal(channel, 'oba-voice-observation'); messages.push(JSON.parse(JSON.stringify(value))) }
        },
        on(channel, handler) { commands.set(channel, handler) },
      }, contextBridge: {
        executeInMainWorld({ func }) { vm.runInContext(`(${func.toString()})()`, mainContext) },
      } }
    } })
  function elements(element = document.documentElement) {
    return [element, ...element.children.flatMap(child => elements(child)), ...(element.shadow ? elements(element.shadow) : [])]
  }
  return { window, messages, commands, windowActions, elements }
}

test('preload forwards only small allowlisted status fields from its own origin and window', () => {
  const { window, messages } = preload()
  window.postMessage({ type: 'serverSettings', payload: { microphone_on_demand: { value: true }, secret: 'must not leave page' } }, window.location.origin)
  window.postMessage({ type: 'sidebarButtonStatusUpdate', microphone: true, text: 'private text' }, window.location.origin)
  window.postMessage({ type: 'stats', data: { isMicrophoneActive: false, private: 'audio or text' } }, window.location.origin)
  window.postMessage({ type: 'sidebarButtonStatusUpdate', microphone: true }, 'https://example.org')
  window.postMessage({ type: 'clipboardContentUpdate', text: 'private clipboard' }, window.location.origin)
  assert.deepEqual(messages, [{ type: 'settings', demand: true }, { type: 'microphone', active: true }, { type: 'microphone', active: false }])
})

test('transport observation follows real local socket events and never marks a remote socket connected', () => {
  const { window, messages } = preload()
  const socket = new window.WebSocket('wss://127.0.0.1:13443/websockets')
  assert.deepEqual(messages, [])
  socket.emit('open')
  socket.emit('close')
  const remote = new window.WebSocket('wss://example.org/websockets')
  remote.emit('open')
  assert.deepEqual(messages, [{ type: 'transport', open: true }, { type: 'transport', open: false }])
})

test('the native command requests microphone once without claiming that it succeeded', () => {
  const { window, messages, commands } = preload()
  const observed = []
  const post = window.postMessage
  window.postMessage = (data, origin) => { observed.push(JSON.parse(JSON.stringify(data))); post(data, origin) }
  assert.ok(commands.has('oba-voice-enable'))
  commands.get('oba-voice-enable')()
  assert.deepEqual(observed, [{ type: 'pipelineControl', pipeline: 'microphone', enabled: true }])
  assert.deepEqual(messages, [])
})

test('visible local controls send only minimize or hide and do not send remote browser commands', () => {
  const { window, messages, windowActions, elements } = preload()
  const buttons = elements().filter(element => element.tagName === 'button')
  assert.deepEqual(buttons.map(button => button.textContent), ['最小化', '收起到后台'])
  assert.ok(elements().some(element => element.textContent === '收起后豆包继续运行'))
  for (const button of buttons) button.events.get('click')({ isTrusted: true, preventDefault() {}, stopPropagation() {} })
  window.postMessage({ type: 'obaVoiceWindowControl', action: 'quit' }, window.location.origin)
  assert.deepEqual(windowActions, ['minimize', 'hide'])
  assert.deepEqual(messages, [])
})

test('local controls are not installed for another origin or embedded frame', () => {
  for (const options of [{ origin: 'https://example.org' }, { mainFrame: false }]) {
    const { elements, windowActions } = preload(options)
    assert.equal(elements().filter(element => element.tagName === 'button').length, 0)
    assert.deepEqual(windowActions, [])
  }
})
