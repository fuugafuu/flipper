import { FRAME_BYTES, HEIGHT, WIDTH } from './format'

export type Dither = 'bayer' | 'floyd' | 'atkinson'
export type Settings = {
  fps: number
  dither: Dither
  contrast: number
  detail: number
  stability: number
  fit: 'contain' | 'cover'
  tone: 'melody' | 'voice'
}

export type ImageRegion = { left: number; top: number; right: number; bottom: number }
export type ToneState = { gain?: number; black?: number }

const bayer = [
  0, 32, 8, 40, 48, 16, 56, 24,
  12, 44, 4, 36, 60, 28, 52, 20,
  3, 35, 11, 43, 51, 19, 59, 27,
  15, 47, 7, 39, 63, 31, 55, 23,
  2, 34, 10, 42, 50, 18, 58, 26,
  14, 46, 6, 38, 62, 30, 54, 22,
  1, 33, 9, 41, 49, 17, 57, 25,
  13, 45, 5, 37, 61, 29, 53, 21,
]

function limit(value: number): number {
  return Math.max(0, Math.min(255, value))
}

export function renderSource(context: CanvasRenderingContext2D, source: CanvasImageSource, width: number, height: number, fit: 'contain' | 'cover'): ImageRegion {
  context.fillStyle = 'black'
  context.fillRect(0, 0, WIDTH, HEIGHT)
  const scale = fit === 'cover' ? Math.max(WIDTH / width, HEIGHT / height) : Math.min(WIDTH / width, HEIGHT / height)
  const drawWidth = width * scale
  const drawHeight = height * scale
  const left = (WIDTH - drawWidth) / 2
  const top = (HEIGHT - drawHeight) / 2
  context.drawImage(source, left, top, drawWidth, drawHeight)
  return {
    left: Math.max(0, Math.ceil(left)),
    top: Math.max(0, Math.ceil(top)),
    right: Math.min(WIDTH, Math.floor(left + drawWidth)),
    bottom: Math.min(HEIGHT, Math.floor(top + drawHeight)),
  }
}

export function convertImage(image: ImageData, settings: Settings, previous?: Uint8Array, region?: ImageRegion, toneState?: ToneState): Uint8Array {
  const pixels = WIDTH * HEIGHT
  const lum = new Float32Array(pixels)
  const histogram = new Uint32Array(256)
  const activeRegion = region ?? { left: 0, top: 0, right: WIDTH, bottom: HEIGHT }
  let activePixels = 0
  for (let i = 0; i < pixels; i++) {
    const offset = i * 4
    const r = image.data[offset], g = image.data[offset + 1], b = image.data[offset + 2]
    const value = r * 0.2126 + g * 0.7152 + b * 0.0722
    lum[i] = value
    const x = i % WIDTH, y = Math.floor(i / WIDTH)
    if (x >= activeRegion.left && x < activeRegion.right && y >= activeRegion.top && y < activeRegion.bottom) {
      histogram[Math.round(value)]++
      activePixels++
    }
  }

  // Percentiles are measured inside the actual picture so letterbox bars do not
  // force a dark scene to stay black. Preserve true black, and avoid boosting noise
  // in essentially empty frames.
  const percentile = (fraction: number) => {
    const target = Math.max(1, Math.ceil(activePixels * fraction))
    let sum = 0
    for (let value = 0; value < histogram.length; value++) {
      sum += histogram[value]
      if (sum >= target) return value
    }
    return 255
  }
  const low = percentile(0.02)
  const high = percentile(0.98)
  const usefulRange = high - low
  const desiredBlack = usefulRange > 8 && high > 12 ? Math.max(0, low - 4) : 0
  const desiredGain = usefulRange > 8 && high > 12
    ? Math.max(1, Math.min(6, 222 / Math.max(36, high - desiredBlack)))
    : 1
  const oldGain = toneState?.gain
  const jump = oldGain !== undefined && (desiredGain / oldGain > 1.65 || oldGain / desiredGain > 1.65)
  const blend = jump ? 0.82 : 0.22
  const gain = oldGain === undefined ? desiredGain : oldGain + (desiredGain - oldGain) * blend
  const black = toneState?.black === undefined ? desiredBlack : toneState.black + (desiredBlack - toneState.black) * blend
  if (toneState) { toneState.gain = gain; toneState.black = black }
  for (let i = 0; i < pixels; i++) {
    const x = i % WIDTH, y = Math.floor(i / WIDTH)
    if (x < activeRegion.left || x >= activeRegion.right || y < activeRegion.top || y >= activeRegion.bottom) {
      lum[i] = 0
      continue
    }
    const normalized = limit((lum[i] - black) * gain) / 255
    const shadowLift = Math.pow(normalized, 0.9) * 255
    lum[i] = limit((shadowLift - 127.5) * settings.contrast + 127.5)
  }

  if (settings.detail > 0) {
    const snapshot = lum.slice()
    const amount = settings.detail / 100 * 1.6
    for (let y = 1; y < HEIGHT - 1; y++) {
      for (let x = 1; x < WIDTH - 1; x++) {
        const p = y * WIDTH + x
        const surround = (snapshot[p - 1] + snapshot[p + 1] + snapshot[p - WIDTH] + snapshot[p + WIDTH]) / 4
        lum[p] = limit(snapshot[p] + (snapshot[p] - surround) * amount)
      }
    }
  }

  const output = new Uint8Array(FRAME_BYTES)
  const keepThreshold = settings.stability / 100 * 26
  const insidePicture = (x: number, y: number) => x >= activeRegion.left && x < activeRegion.right && y >= activeRegion.top && y < activeRegion.bottom
  const setPixel = (pixel: number, on: boolean, threshold: number) => {
    if (!insidePicture(pixel % WIDTH, Math.floor(pixel / WIDTH))) on = true
    else if (previous && Math.abs(lum[pixel] - threshold) < keepThreshold) {
      on = Boolean(previous[pixel >> 3] & (0x80 >> (pixel & 7)))
    }
    if (on) output[pixel >> 3] |= 0x80 >> (pixel & 7)
  }

  if (settings.dither === 'bayer') {
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const p = y * WIDTH + x
        const threshold = 127.5 + (bayer[(y & 7) * 8 + (x & 7)] - 31.5) * 2.35
        // Flipper LCD uses 1 for an energized (dark) pixel.
        setPixel(p, lum[p] < threshold, threshold)
      }
    }
    return output
  }

  const work = lum.slice()
  const atkinson = settings.dither === 'atkinson'
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const p = y * WIDTH + x
      const on = work[p] < 128
      setPixel(p, on, 128)
      const selected = Boolean(output[p >> 3] & (0x80 >> (p & 7)))
      const error = work[p] - (selected ? 0 : 255)
      const spread = (dx: number, dy: number, strength: number) => {
        const nx = x + dx, ny = y + dy
        if (nx >= 0 && nx < WIDTH && ny < HEIGHT && insidePicture(nx, ny)) work[ny * WIDTH + nx] += error * strength
      }
      if (atkinson) {
        spread(1, 0, 1 / 8); spread(2, 0, 1 / 8)
        spread(-1, 1, 1 / 8); spread(0, 1, 1 / 8); spread(1, 1, 1 / 8)
        spread(0, 2, 1 / 8)
      } else {
        spread(1, 0, 7 / 16); spread(-1, 1, 3 / 16)
        spread(0, 1, 5 / 16); spread(1, 1, 1 / 16)
      }
    }
  }
  return output
}

export function audioArtwork(context: CanvasRenderingContext2D, progress: number, intensity: number) {
  context.fillStyle = '#101c1a'
  context.fillRect(0, 0, WIDTH, HEIGHT)
  context.fillStyle = '#a4c3a2'
  context.font = 'bold 9px monospace'
  context.textAlign = 'center'
  context.fillText('AUDIO SIGNAL', 64, 14)
  for (let i = 0; i < 23; i++) {
    const level = Math.abs(Math.sin(progress * 4.6 + i * 0.83) * Math.cos(i * 0.4 + progress * 1.9))
    const height = 3 + Math.round(level * intensity * 31)
    context.fillRect(8 + i * 5, 50 - height, 3, height)
  }
  context.fillRect(8, 56, Math.round(112 * progress), 2)
}
