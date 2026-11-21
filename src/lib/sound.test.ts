import { describe, expect, it } from 'vitest'
import { trackBuzzer } from './sound'
import type { Settings } from './vision'

const settings: Settings = {
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
    expect(new Set(ticks.map(tick => tick.frequency)).size).toBeGreaterThan(2)
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
