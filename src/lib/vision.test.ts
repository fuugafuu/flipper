import { describe, expect, it } from 'vitest'
import { HEIGHT, WIDTH } from './format'
import { convertImage, type Settings, type ToneState } from './vision'

const settings: Settings = {
  mode: 'video-8bit',
  fps: 60, dither: 'bayer', contrast: 1, detail: 0,
  stability: 0, fit: 'contain', tone: 'melody',
}

function makeImage(valueAt: (x: number, y: number) => number): ImageData {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4)
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const offset = (y * WIDTH + x) * 4
      data[offset] = data[offset + 1] = data[offset + 2] = valueAt(x, y)
      data[offset + 3] = 255
    }
  }
  return { data, width: WIDTH, height: HEIGHT } as ImageData
}

function dark(frame: Uint8Array, x: number, y: number): boolean {
  const pixel = y * WIDTH + x
  return Boolean(frame[pixel >> 3] & (0x80 >> (pixel & 7)))
}

describe('1-bit image conversion', () => {
  it('uses the LCD convention where 1 is a dark pixel', () => {
    const image = makeImage(x => x < 64 ? 0 : 255)
    const frame = convertImage(image, settings)
    expect(dark(frame, 20, 30)).toBe(true)
    expect(dark(frame, 110, 30)).toBe(false)
  })

  it('reveals details in a dark scene without brightening letterbox bars', () => {
    const image = makeImage((x, y) => y < 12 || y >= 52 ? 0 : Math.round(2 + x / 127 * 49))
    const region = { left: 0, top: 12, right: WIDTH, bottom: 52 }
    const frame = convertImage(image, settings, undefined, region)
    let visibleHighlights = 0
    for (let y = 12; y < 52; y++) {
      for (let x = 80; x < WIDTH; x++) if (!dark(frame, x, y)) visibleHighlights++
    }
    expect(visibleHighlights).toBeGreaterThan(300)
    for (let x = 0; x < WIDTH; x++) {
      expect(dark(frame, x, 0)).toBe(true)
      expect(dark(frame, x, 63)).toBe(true)
    }
  })

  it('smooths exposure between similar frames and adapts quickly on scene cuts', () => {
    const state: ToneState = {}
    convertImage(makeImage(x => x / 127 * 48), settings, undefined, undefined, state)
    const darkGain = state.gain!
    convertImage(makeImage(x => x / 127 * 53), settings, undefined, undefined, state)
    expect(state.gain).toBeLessThan(darkGain)
    expect(state.gain).toBeGreaterThan(darkGain * 0.8)
    convertImage(makeImage(x => x / 127 * 250), settings, undefined, undefined, state)
    expect(state.gain).toBeLessThan(2)
  })
})
