export function createToneWav({ seconds = 8, sampleRate = 48000, frequency = 440 } = {}) {
  if (!(seconds > 0 && seconds <= 30 && sampleRate >= 8000 && sampleRate <= 96000 && frequency > 0 && frequency < sampleRate / 2)) throw new Error('Invalid synthetic tone parameters')
  const samples = Math.round(seconds * sampleRate)
  const buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(buffer.length - 8, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples * 2, 40)
  for (let index = 0; index < samples; index++) buffer.writeInt16LE(Math.round(0.2 * 32767 * Math.sin(2 * Math.PI * frequency * index / sampleRate)), 44 + index * 2)
  return buffer
}

export function isForwardedTone(value) {
  return Number.isFinite(value?.maxRms) && value.maxRms > 0.005 && Number.isFinite(value?.peakHz) && Math.abs(value.peakHz - 440) < 60
}

export function audioProbeExpression() {
  return `(${async function measureVirtualInput() {
    let stream
    let context
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
      context = new AudioContext()
      await Promise.race([context.resume(), new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Virtual input AudioContext did not resume')), 2000))])
      const analyser = context.createAnalyser()
      analyser.fftSize = 4096
      context.createMediaStreamSource(stream).connect(analyser)
      const samples = new Float32Array(analyser.fftSize)
      const frequencies = new Float32Array(analyser.frequencyBinCount)
      let maxRms = 0
      let peakHz = 0
      const deadline = performance.now() + 4000
      while (performance.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50))
        analyser.getFloatTimeDomainData(samples)
        analyser.getFloatFrequencyData(frequencies)
        const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length)
        if (rms > maxRms) {
          maxRms = rms
          let bin = 1
          for (let candidate = 2; candidate < frequencies.length; candidate++) if (frequencies[candidate] > frequencies[bin]) bin = candidate
          peakHz = bin * context.sampleRate / analyser.fftSize
        }
      }
      return { maxRms, peakHz, sampleRate: context.sampleRate }
    } finally {
      stream?.getTracks().forEach(track => track.stop())
      await context?.close()
    }
  }.toString()})()`
}
