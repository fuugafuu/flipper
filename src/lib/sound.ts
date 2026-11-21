import type { BuzzerTick } from './format'
import { AUDIO_TICK_MS } from './format'
import type { Settings } from './vision'

const SAMPLE_RATE = 8000
const FFT_SIZE = 1024

function fft(real: Float32Array, imaginary: Float32Array) {
  const n = real.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const realValue = real[i]; real[i] = real[j]; real[j] = realValue
      const imaginaryValue = imaginary[i]; imaginary[i] = imaginary[j]; imaginary[j] = imaginaryValue
    }
  }
  for (let len = 2; len <= n; len *= 2) {
    const theta = -2 * Math.PI / len
    const wReal = Math.cos(theta), wImaginary = Math.sin(theta)
    for (let i = 0; i < n; i += len) {
      let wr = 1, wi = 0
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2
        const tr = wr * real[b] - wi * imaginary[b]
        const ti = wi * real[b] + wr * imaginary[b]
        real[b] = real[a] - tr; imaginary[b] = imaginary[a] - ti
        real[a] += tr; imaginary[a] += ti
        const nextReal = wr * wReal - wi * wImaginary
        wi = wr * wImaginary + wi * wReal; wr = nextReal
      }
    }
  }
}

function waveformSamples(buffer: AudioBuffer, duration: number): Float32Array {
  const length = Math.floor(Math.min(buffer.duration, duration) * SAMPLE_RATE)
  const samples = new Float32Array(length)
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i))
  const ratio = buffer.sampleRate / SAMPLE_RATE
  for (let i = 0; i < length; i++) {
    const position = i * ratio
    const base = Math.floor(position)
    const fraction = position - base
    for (const channel of channels) {
      if (ratio > 1.5) {
        // Integrate the source interval before downsampling. Point sampling aliases
        // cymbals and consonants into false pitches on typical 44.1/48 kHz files.
        const end = Math.min(channel.length, Math.ceil(position + ratio))
        let sum = 0
        let weight = 0
        for (let source = base; source < end; source++) {
          const overlap = Math.min(position + ratio, source + 1) - Math.max(position, source)
          if (overlap > 0) { sum += (channel[source] || 0) * overlap; weight += overlap }
        }
        samples[i] += (weight ? sum / weight : 0) / channels.length
      } else {
        const first = channel[base] || 0
        samples[i] += (first + ((channel[base + 1] || first) - first) * fraction) / channels.length
      }
    }
  }
  return samples
}

export async function trackBuzzer(buffer: AudioBuffer, seconds: number, settings: Settings, onProgress: (value: number) => void, signal: AbortSignal): Promise<BuzzerTick[]> {
  const samples = waveformSamples(buffer, seconds)
  const tickCount = Math.ceil(samples.length / (SAMPLE_RATE * AUDIO_TICK_MS / 1000))
  const real = new Float32Array(FFT_SIZE)
  const imaginary = new Float32Array(FFT_SIZE)
  const magnitudes = new Float32Array(FFT_SIZE / 2)
  const window = new Float32Array(FFT_SIZE)
  for (let i = 0; i < FFT_SIZE; i++) window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1))

  const candidates: { pitch: number; rms: number }[] = []
  let previousPitch = 0
  for (let tick = 0; tick < tickCount; tick++) {
    if (signal.aborted) throw new DOMException('変換を中止しました', 'AbortError')
    const center = Math.floor(tick * SAMPLE_RATE * AUDIO_TICK_MS / 1000)
    let power = 0
    for (let i = 0; i < FFT_SIZE; i++) {
      const sample = samples[center + i - FFT_SIZE / 2] || 0
      real[i] = sample * window[i]
      imaginary[i] = 0
      power += sample * sample
    }
    const rms = Math.sqrt(power / FFT_SIZE)
    fft(real, imaginary)
    for (let i = 0; i < magnitudes.length; i++) {
      magnitudes[i] = Math.hypot(real[i], imaginary[i])
    }

    const minFrequency = settings.tone === 'voice' ? 125 : 105
    const maxFrequency = settings.tone === 'voice' ? 1900 : 2250
    let bestBin = 0
    let bestScore = -Infinity
    for (let bin = Math.ceil(minFrequency * FFT_SIZE / SAMPLE_RATE); bin <= Math.floor(maxFrequency * FFT_SIZE / SAMPLE_RATE); bin++) {
      const frequency = bin * SAMPLE_RATE / FFT_SIZE
      let score = magnitudes[bin]
      if (bin * 2 < magnitudes.length) score += magnitudes[bin * 2] * 0.62
      if (bin * 3 < magnitudes.length) score += magnitudes[bin * 3] * 0.31
      // Prefer fundamentals in the strongest part of a melody/voice spectrum.
      const centerPreference = settings.tone === 'voice' ? 460 : 370
      score *= 1 / (1 + Math.abs(Math.log2(frequency / centerPreference)) * 0.22)
      if (previousPitch > 0) {
        const semitones = Math.abs(12 * Math.log2(frequency / previousPitch))
        score *= 1 / (1 + Math.min(12, semitones) * 0.018)
      }
      if (score > bestScore) { bestScore = score; bestBin = bin }
    }
    const left = magnitudes[Math.max(0, bestBin - 1)]
    const middle = magnitudes[bestBin]
    const right = magnitudes[Math.min(magnitudes.length - 1, bestBin + 1)]
    const denominator = left - 2 * middle + right
    const correction = Math.abs(denominator) > 1e-6 ? Math.max(-0.5, Math.min(0.5, 0.5 * (left - right) / denominator)) : 0
    const pitch = Math.round((bestBin + correction) * SAMPLE_RATE / FFT_SIZE)
    candidates.push({ pitch, rms })
    if (rms > 0.0002) previousPitch = pitch
    if (tick % 64 === 0) {
      onProgress(tick / Math.max(1, tickCount))
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }

  // A robust loudness reference ignores isolated drum hits. The old confidence
  // threshold divided one note by the energy of *all* instruments and erased
  // almost every note in mixed music.
  const sortedRms = candidates.map(candidate => candidate.rms).sort((a, b) => a - b)
  const reference = sortedRms[Math.floor((sortedRms.length - 1) * 0.95)] || 0
  const gateThreshold = Math.max(0.0001, reference * 0.018)
  let smoothGain = 0
  let smoothPitch = 0
  const ticks = candidates.map((candidate, index) => {
    const active = candidate.rms > gateThreshold
    const targetGain = active ? Math.min(255, Math.round(Math.pow(candidate.rms / Math.max(0.0001, reference), 0.55) * 220)) : 0
    smoothGain += (targetGain - smoothGain) * (targetGain > smoothGain ? 0.7 : 0.48)
    if (active) {
      // Reject one-frame octave/glitch jumps but keep real note changes.
      const next = candidates[index + 1]
      const jump = smoothPitch > 0 ? Math.abs(12 * Math.log2(candidate.pitch / smoothPitch)) : 0
      const nextSupports = next && Math.abs(12 * Math.log2(next.pitch / candidate.pitch)) < 3
      const stablePitch = jump > 8 && !nextSupports ? smoothPitch : candidate.pitch
      smoothPitch = smoothPitch && Math.abs(12 * Math.log2(stablePitch / smoothPitch)) < 2
        ? smoothPitch * 0.4 + stablePitch * 0.6 : stablePitch
    }
    return {
      frequency: smoothGain < 9 || !active ? 0 : Math.max(100, Math.min(2500, Math.round(smoothPitch))),
      gain: active ? Math.round(smoothGain) : 0,
      gate: active ? 100 : 0,
    }
  })
  onProgress(1)
  return ticks
}

export async function decodeAudio(file: File, notify: (text: string) => void): Promise<AudioBuffer> {
  if (file.type.startsWith('audio/') || /\.(wav|mp3|m4a|ogg|aac|flac)$/i.test(file.name)) {
    try {
      const context = new AudioContext()
      try { return await context.decodeAudioData(await file.arrayBuffer()) }
      finally { void context.close() }
    } catch { /* FFmpeg fallback for unsupported codecs. */ }
  }

  notify('音声トラックを分離中 · FFmpegエンジンを読み込みます')
  const [{ FFmpeg }, { fetchFile, toBlobURL }] = await Promise.all([
    import('@ffmpeg/ffmpeg'), import('@ffmpeg/util'),
  ])
  const ffmpeg = new FFmpeg()
  const base = `${import.meta.env.BASE_URL}ffmpeg`
  const extension = file.name.split('.').at(-1)?.replace(/[^a-z0-9]/gi, '') || 'bin'
  const input = `source.${extension}`
  try {
    await ffmpeg.load({
      coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
    })
    await ffmpeg.writeFile(input, await fetchFile(file))
    const code = await ffmpeg.exec(['-i', input, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), 'audio.wav'])
    if (code !== 0) throw new Error('音声トラックを抽出できませんでした')
    const output = await ffmpeg.readFile('audio.wav')
    if (typeof output === 'string') throw new Error('音声データを読み取れませんでした')
    const audioContext = new AudioContext()
    try { return await audioContext.decodeAudioData(new Uint8Array(output).buffer) }
    finally { void audioContext.close() }
  } finally {
    ffmpeg.terminate()
  }
}

export type PlaybackHandle = { context: AudioContext; start: number; stop: () => void }

export function playBuzzer(ticks: BuzzerTick[], offsetSeconds: number): PlaybackHandle {
  const context = new AudioContext()
  // iOS Safari requires resume() and oscillator.start() inside the same tap.
  // Never await a media play promise before starting the audio graph.
  void context.resume().catch(() => { /* The UI detects a suspended context. */ })
  const oscillator = context.createOscillator()
  oscillator.type = 'square'
  const gain = context.createGain()
  const highpass = context.createBiquadFilter()
  highpass.type = 'highpass'; highpass.frequency.value = 110
  const lowpass = context.createBiquadFilter()
  lowpass.type = 'lowpass'; lowpass.frequency.value = 2600
  oscillator.connect(highpass).connect(lowpass).connect(gain).connect(context.destination)
  const start = context.currentTime + 0.06
  gain.gain.setValueAtTime(0, context.currentTime)
  // Queue only the next half-second of buzzer events to avoid unbounded Web Audio automation.
  let nextTick = Math.floor(offsetSeconds * 1000 / AUDIO_TICK_MS)
  const schedule = () => {
    const horizon = context.currentTime + 0.5
    while (nextTick < ticks.length) {
      const time = Math.max(start, start + nextTick * AUDIO_TICK_MS / 1000 - offsetSeconds)
      if (time > horizon) break
      const tick = ticks[nextTick++]
      oscillator.frequency.setTargetAtTime(Math.max(100, tick.frequency || 440), time, 0.003)
      const volume = tick.frequency ? Math.pow(tick.gain / 255, 1.15) * 0.14 : 0
      gain.gain.setTargetAtTime(volume, time, 0.003)
      if (tick.gate < 100) gain.gain.setTargetAtTime(0, time + AUDIO_TICK_MS / 1000 * tick.gate / 100, 0.002)
    }
    if (nextTick >= ticks.length) clearInterval(timer)
  }
  const timer = window.setInterval(schedule, 100)
  schedule()
  oscillator.start(start)
  oscillator.stop(start + Math.max(0.02, ticks.length * AUDIO_TICK_MS / 1000 - offsetSeconds) + 0.02)
  return { context, start, stop: () => { clearInterval(timer); try { oscillator.stop() } catch { /* stopped */ } void context.close() } }
}
