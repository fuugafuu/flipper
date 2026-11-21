import { FRAME_BYTES, HEIGHT, WIDTH } from './format'

export type Dither = 'bayer' | 'floyd' | 'atkinson'
export type Settings = {
  fps: number
  duration: number
  dither: Dither
  contrast: number
  detail: number
  stability: number
  fit: 'contain' | 'cover'
  tone: 'melody' | 'voice'
}

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

export function renderSource(context: CanvasRenderingContext2D, source: CanvasImageSource, width: number, height: number, fit: 'contain' | 'cover') {
  context.fillStyle = 'black'
  context.fillRect(0, 0, WIDTH, HEIGHT)
  const scale = fit === 'cover' ? Math.max(WIDTH / width, HEIGHT / height) : Math.min(WIDTH / width, HEIGHT / height)
  const drawWidth = width * scale
  const drawHeight = height * scale
  context.drawImage(source, (WIDTH - drawWidth) / 2, (HEIGHT - drawHeight) / 2, drawWidth, drawHeight)
}

export function convertImage(image: ImageData, settings: Settings, previous?: Uint8Array): Uint8Array {
  const pixels = WIDTH * HEIGHT
  const lum = new Float32Array(pixels)
  for (let i = 0; i < pixels; i++) {
    const offset = i * 4
    const r = image.data[offset], g = image.data[offset + 1], b = image.data[offset + 2]
    lum[i] = (r * 0.2126 + g * 0.7152 + b * 0.0722 - 127.5) * settings.contrast + 127.5
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
  const setPixel = (pixel: number, on: boolean, threshold: number) => {
    if (previous && Math.abs(lum[pixel] - threshold) < keepThreshold) {
      on = Boolean(previous[pixel >> 3] & (0x80 >> (pixel & 7)))
    }
    if (on) output[pixel >> 3] |= 0x80 >> (pixel & 7)
  }

  if (settings.dither === 'bayer') {
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const p = y * WIDTH + x
        const threshold = 127.5 + (bayer[(y & 7) * 8 + (x & 7)] - 31.5) * 2.35
        setPixel(p, lum[p] >= threshold, threshold)
      }
    }
    return output
  }

  const work = lum.slice()
  const atkinson = settings.dither === 'atkinson'
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const p = y * WIDTH + x
      const on = work[p] >= 128
      setPixel(p, on, 128)
      const selected = Boolean(output[p >> 3] & (0x80 >> (p & 7)))
      const error = work[p] - (selected ? 255 : 0)
      const spread = (dx: number, dy: number, strength: number) => {
        const nx = x + dx, ny = y + dy
        if (nx >= 0 && nx < WIDTH && ny < HEIGHT) work[ny * WIDTH + nx] += error * strength
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
