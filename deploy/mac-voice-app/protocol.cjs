class MicrophoneGate {
  constructor() {
    this.connected = false
    this.settings = false
    this.demand = false
    this.attempted = false
  }

  accept(event) {
    if (event.type === 'transport') {
      this.connected = event.open === true
      if (!this.connected) { this.settings = false; this.attempted = false }
    } else if (event.type === 'settings') {
      this.settings = true
      this.demand = event.demand === true
    }
    if (this.connected && this.settings && !this.demand && !this.attempted) {
      this.attempted = true
      return true
    }
    return false
  }
}

module.exports = { MicrophoneGate }
