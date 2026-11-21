import { describe, expect, it } from 'vitest'
import { decodeAdpcm, encodeAdpcm, pcmWaveform, preparePcm, PCM_SAMPLE_RATE } from './pcm'
import { decodeClip, encodeClip, FRAME_BYTES, type FlipperClip } from './format'

function music(length: number): Int16Array {
  return Int16Array.from({ length }, (_, i) => {
    const time = i / PCM_SAMPLE_RATE
    return Math.round(11000 * Math.sin(time * Math.PI * 2 * 440) +
      7000 * Math.sin(time * Math.PI * 2 * 660) +
      5000 * Math.sin(time * Math.PI * 2 * 220))
  })
}

describe('16kHz block IMA ADPCM audio', () => {
  it('keeps independent blocks and exact duration when the final block is partial', () => {
    const input = music(16021)
    const pcm = encodeAdpcm(input)
    expect(pcm.sampleRate).toBe(16000)
    expect(pcm.sampleCount).toBe(input.length)
    expect(pcm.data.length).toBe(Math.ceil(input.length / 256) * 132)
    const output = decodeAdpcm(pcm)
    expect(output.length).toBe(input.length)
    expect(output[256]).toBe(input[256])
    expect(output[512]).toBe(input[512])
    let sourcePower = 0
    let errorPower = 0
    for (let i = 0; i < input.length; i++) {
      sourcePower += input[i] ** 2
      errorPower += (input[i] - output[i]) ** 2
    }
    expect(10 * Math.log10(sourcePower / errorPower)).toBeGreaterThan(17)
    expect(pcmWaveform(pcm).some(level => level > 15)).toBe(true)
  })

  it('encodes FZMV v2 and decodes the exported bytes without changing samples', () => {
    const pcm = encodeAdpcm(music(12653))
    const original: FlipperClip = {
      durationMs: 791, fps: 10,
      frames: [new Uint8Array(FRAME_BYTES), new Uint8Array(FRAME_BYTES).fill(255)],
      audio: [], pcm,
    }
    const bytes = encodeClip(original)
    expect(new DataView(bytes.buffer).getUint16(4, true)).toBe(2)
    expect(decodeClip(bytes)).toEqual(original)
    const corrupt = bytes.slice()
    new DataView(corrupt.buffer).setUint16(58, 512, true)
    expect(() => decodeClip(corrupt)).toThrow('未対応のPCMコーデック')
    const truncated = bytes.subarray(0, bytes.length - 1)
    expect(() => decodeClip(truncated)).toThrow()
  })

  it('converts stereo music while keeping quiet and silent regions', async () => {
    const duration = 2
    const sampleRate = 44100
    const left = Float32Array.from({ length: duration * sampleRate }, (_, i) => {
      const time = i / sampleRate
      return time < 1 ? 0.12 * Math.sin(2 * Math.PI * 440 * time) :
        time < 1.5 ? 0.015 * Math.sin(2 * Math.PI * 440 * time) : 0
    })
    const right = Float32Array.from(left, sample => sample * 0.75)
    const buffer = {
      numberOfChannels: 2, sampleRate, duration,
      getChannelData: (index: number) => index ? right : left,
    } as unknown as AudioBuffer
    const pcm = await preparePcm(buffer, duration, () => {}, new AbortController().signal)
    const output = decodeAdpcm(pcm)
    const rms = (from: number, to: number) => {
      const section = output.subarray(from * PCM_SAMPLE_RATE, to * PCM_SAMPLE_RATE)
      let power = 0
      for (const sample of section) power += sample * sample
      return Math.sqrt(power / section.length)
    }
    expect(rms(0.2, 0.8)).toBeGreaterThan(3000)
    expect(rms(1.1, 1.4)).toBeGreaterThan(250)
    expect(rms(1.7, 1.95)).toBeLessThan(15)
  })
})
