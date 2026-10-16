const { initialState, transition } = require('./state.cjs')
const { isAllowedWindowAction } = require('./policy.cjs')

class VoiceConnection {
  constructor({ openWindow, onState = () => {} }) {
    this.openWindow = openWindow
    this.onState = onState
    this.state = initialState()
    this.window = null
  }

  update(event) {
    this.state = transition(this.state, event)
    this.onState(this.state)
  }

  start() {
    if (this.window || this.state.phase === 'paused' || this.state.phase === 'quit') return
    const window = this.openWindow()
    this.window = window
    window.on('close', event => {
      if (this.state.phase !== 'quit') { event.preventDefault(); window.hide() }
    })
    window.on('closed', () => {
      if (this.window === window) {
        this.window = null
        this.update({ type: 'transport', open: false })
      }
    })
    this.onState(this.state)
  }

  show() {
    if (this.state.phase === 'paused' || this.state.phase === 'quit') return
    this.start()
    this.window?.show()
    this.window?.focus()
  }

  performWindowAction(action) {
    if (!isAllowedWindowAction(action) || !this.window || this.window.isDestroyed() ||
      this.state.phase === 'paused' || this.state.phase === 'quit') return false
    if (action === 'minimize') this.window.minimize()
    else this.window.hide()
    return true
  }

  pause() {
    this.update({ type: 'pause' })
    const window = this.window
    this.window = null
    window?.destroy()
  }

  resume() {
    if (this.state.phase === 'quit') return
    this.update({ type: 'resume' })
    this.start()
  }

  quit() {
    this.update({ type: 'quit' })
    const window = this.window
    this.window = null
    window?.destroy()
  }
}

module.exports = { VoiceConnection }
