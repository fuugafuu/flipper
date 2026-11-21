import { describe, expect, it } from 'vitest'
import { decodeClip, encodeClip, FRAME_BYTES, type FlipperClip } from './format'
import { encodeAdpcm } from './pcm'

function fixture(): FlipperClip {
  const white = new Uint8Array(FRAME_BYTES).fill(255)
  const black = new Uint8Array(FRAME_BYTES)
  const noise = Uint8Array.from({ length: FRAME_BYTES }, (_, i) => (i * 97 + (i >>> 3)) & 255)
  const smallChange = white.slice()
  smallChange[125] = 0
  return {
    fps: 10,
    durationMs: 1000,
    frames: [black, black.slice(), white, smallChange, white, noise, noise.slice()],
    audio: [{ frequency: 440, gain: 240, gate: 100 }, { frequency: 0, gain: 0, gate: 0 }, { frequency: 1500, gain: 90, gate: 50 }],
  }
}

describe('FZMV v1 codec', () => {
  it('preserves raw, RLE and XOR frames as well as buzzer events', () => {
    const source = fixture()
    const data = encodeClip(source)
    const decoded = decodeClip(data)
    expect(decoded).toEqual(source)
    expect(data.length).toBeLessThan(64 + source.frames.length * (FRAME_BYTES + 7) + source.audio.length * 4)
  })

  it('encodes a full 128×64 1-bit frame in 1024 bytes', () => {
    expect(FRAME_BYTES).toBe(1024)
    const source = fixture()
    expect(new TextDecoder().decode(encodeClip(source).subarray(0, 4))).toBe('FZMV')
  })

  it('rejects malformed and unsupported headers', () => {
    const bytes = encodeClip(fixture())
    expect(() => decodeClip(new Uint8Array([1, 2, 3]))).toThrow()
    const wrongVersion = bytes.slice()
    wrongVersion[4] = 2
    expect(() => decodeClip(wrongVersion)).toThrow()
    expect(() => decodeClip(bytes.subarray(0, 80))).toThrow()
  })

  it('handles a keyframe boundary and arbitrary full-frame bit patterns', () => {
    const frames = Array.from({ length: 45 }, (_, index) =>
      Uint8Array.from({ length: FRAME_BYTES }, (_, i) => index % 6 === 0 ? 255 : (index * 11 + i * 29) & 255))
    const source: FlipperClip = { frames, fps: 10, durationMs: 4500, audio: [] }
    expect(decodeClip(encodeClip(source))).toEqual(source)
  })

  it('round-trips a full-length 60 FPS clip with keyframe intervals', () => {
    const frames = Array.from({ length: 241 }, (_, i) =>
      new Uint8Array(FRAME_BYTES).fill(i % 3 === 0 ? 0xff : i % 3 === 1 ? 0x55 : 0xaa))
    const source: FlipperClip = { frames, fps: 60, durationMs: 4017, audio: [] }
    expect(decodeClip(encodeClip(source))).toEqual(source)
  })
})

describe('FZMV v3 playback modes', () => {
  it('round-trips the retro and tracker modes', () => {
    for (const mode of ['video-8bit', 'tracker'] as const) {
      const source = { ...fixture(), mode }
      const file = encodeClip(source)
      expect(new DataView(file.buffer).getUint16(4, true)).toBe(3)
      expect(decodeClip(file)).toEqual(source)
    }
  })

  it('keeps silent high-fidelity video playable', () => {
    const source: FlipperClip = { ...fixture(), mode: 'video-hifi', audio: [] }
    expect(decodeClip(encodeClip(source))).toEqual(source)
  })

  it('round-trips high-fidelity audio without misreading the mode byte as codec data', () => {
    const samples = Int16Array.from({ length: 700 }, (_, i) => Math.round(8000 * Math.sin(i / 8)))
    const source: FlipperClip = { ...fixture(), mode: 'video-hifi', audio: [], pcm: encodeAdpcm(samples) }
    expect(decodeClip(encodeClip(source))).toEqual(source)
  })
})
