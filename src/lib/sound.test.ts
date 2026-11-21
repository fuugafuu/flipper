import { describe, expect, it, vi } from 'vitest'
import { playPcm, trackBuzzer } from './sound'
import { encodeAdpcm } from './pcm'
import type { Settings } from './vision'

const settings: Settings = {
  mode: 'video-8bit',
  fps: 30, dither: 'atkinson', contrast: 1.2,
  detail: 40, stability: 40, fit: 'contain', tone: 'melody',
}

function makeBuffer(seconds: number, signal: (time: number) => number, sampleRate = 8000): AudioBuffer {
  const samples = new Float32Array(Math.floor(seconds * sampleRate))
  for (let i = 0; i < samples.length; i++) samples[i] = signal(i / sampleRate)
  return {
    duration: seconds,
    sampleRate,
    numberOfChannels: 1,
    getChannelData: () => samples,
  } as unknown as AudioBuffer
}

async function convertAudio(buffer: AudioBuffer) {
  return trackBuzzer(buffer, buffer.duration, settings, () => {}, new AbortController().signal)
}

describe('buzzer sound tracking', () => {
  it('preserves sustained single notes and their approximate pitch', async () => {
    const ticks = await convertAudio(makeBuffer(1, t => 0.18 * Math.sin(2 * Math.PI * 440 * t)))
    expect(ticks.filter(tick => tick.gain > 0).length).toBeGreaterThan(46)
    expect(ticks.slice(5, 45).filter(tick => Math.abs(tick.frequency - 440) < 25).length).toBeGreaterThan(34)
  })

  it('keeps polyphonic music audible rather than gating nearly all ticks', async () => {
    const ticks = await convertAudio(makeBuffer(3, t => {
      const melody = 0.11 * Math.sin(2 * Math.PI * (t < 1.5 ? 440 : 523.25) * t)
      const harmony = 0.13 * Math.sin(2 * Math.PI * 330 * t)
      const bass = 0.11 * Math.sin(2 * Math.PI * 165 * t)
      const percussion = 0.13 * Math.exp(-((t * 4) % 1) * 16) * Math.sin(2 * Math.PI * 1000 * t)
      return melody + harmony + bass + percussion
    }))
    expect(ticks.filter(tick => tick.frequency > 0 && tick.gain > 0).length / ticks.length).toBeGreaterThan(0.9)
    expect(new Set(ticks.map(tick => tick.frequency)).size).toBeGreaterThan(1)
  })

  it('retains quiet passages but silences truly empty sections', async () => {
    const ticks = await convertAudio(makeBuffer(3, t => {
      const amplitude = t < 1 ? 0.15 : t < 2 ? 0.009 : 0
      return amplitude * Math.sin(2 * Math.PI * 440 * t)
    }, 48000))
    expect(ticks.slice(55, 92).filter(tick => tick.gain > 0).length).toBeGreaterThan(30)
    expect(ticks.slice(110).filter(tick => tick.gain > 0).length).toBe(0)
  })

  it('does not invent buzzer events from silence', async () => {
    const ticks = await convertAudio(makeBuffer(0.5, () => 0))
    expect(ticks.every(tick => tick.frequency === 0 && tick.gain === 0)).toBe(true)
  })
})

describe('PCM preview modes', () => {
  it('only colors audio in buzzer mode, without changing the encoded FZMV data', () => {
    const filters: Array<{ type: string; frequency: { value: number } }> = []
    const waveshapers: Array<{ curve: Float32Array | null }> = []
    const node = () => ({ connect(next: unknown) { return next } })

    class TestAudioContext {
      currentTime = 0
      destination = node()
      resume = async () => {}
      close = async () => {}
      createBuffer(_channels: number, size: number, rate: number) {
        return { duration: size / rate, copyToChannel(_samples: Float32Array) {} }
      }
      createBufferSource() {
        return { ...node(), buffer: null, start(_time: number, _offset: number) {}, stop() {} }
      }
      createBiquadFilter() {
        const filter = { ...node(), type: '', frequency: { value: 0 }, Q: { value: 0 }, gain: { value: 0 } }
        filters.push(filter)
        return filter
      }
      createWaveShaper() {
        const shaper = { ...node(), curve: null as Float32Array | null, oversample: 'none' }
        waveshapers.push(shaper)
        return shaper
      }
      createGain() { return { ...node(), gain: { value: 0 } } }
    }

    vi.stubGlobal('AudioContext', TestAudioContext)
    try {
      const pcm = encodeAdpcm(Int16Array.from({ length: 1600 }, (_, i) => Math.round(Math.sin(i * 0.15) * 12000)))
      const originalBytes = pcm.data.slice()
      const estimated = playPcm(pcm, 0)
      expect(filters.map(filter => [filter.type, filter.frequency.value])).toEqual([
        ['highpass', 450], ['peaking', 1550], ['lowpass', 2300],
      ])
      expect(waveshapers).toHaveLength(1)
      expect(waveshapers[0].curve).toHaveLength(1025)
      estimated.stop()

      filters.length = 0
      waveshapers.length = 0
      const direct = playPcm(pcm, 0, 'data')
      expect(filters).toHaveLength(0)
      expect(waveshapers).toHaveLength(0)
      expect(pcm.data).toEqual(originalBytes)
      direct.stop()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
