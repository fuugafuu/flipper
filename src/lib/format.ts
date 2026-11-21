export const WIDTH = 128
export const HEIGHT = 64
export const FRAME_BYTES = WIDTH * HEIGHT / 8
export const AUDIO_TICK_MS = 20
export type BuzzerTick = { frequency: number; gain: number; gate: number }
export type FlipperClip = {
  fps: number
  durationMs: number
  frames: Uint8Array[]
  audio: BuzzerTick[]
}

function rleEncode(source: Uint8Array): Uint8Array {
  const output: number[] = []
  let offset = 0
  while (offset < source.length) {
    let run = 1
    while (run < 128 && offset + run < source.length && source[offset + run] === source[offset]) run++
    if (run >= 3) {
      output.push(0x80 | (run - 1), source[offset])
      offset += run
      continue
    }
    const start = offset
    offset += run
    while (offset < source.length && offset - start < 128) {
      let nextRun = 1
      while (nextRun < 3 && offset + nextRun < source.length && source[offset + nextRun] === source[offset]) nextRun++
      if (nextRun >= 3 || offset + nextRun - start > 128) break
      offset += nextRun
    }
    output.push(offset - start - 1)
    for (let i = start; i < offset; i++) output.push(source[i])
  }
  return Uint8Array.from(output)
}

function rleDecode(source: Uint8Array): Uint8Array {
  const output = new Uint8Array(FRAME_BYTES)
  let read = 0
  let write = 0
  while (read < source.length) {
    const instruction = source[read++]
    const count = (instruction & 0x7f) + 1
    if (write + count > FRAME_BYTES) throw new Error('RLEデータが破損しています')
    if (instruction & 0x80) {
      if (read >= source.length) throw new Error('RLEデータが途切れています')
      output.fill(source[read++], write, write + count)
    } else {
      if (read + count > source.length) throw new Error('RLEデータが途切れています')
      output.set(source.subarray(read, read + count), write)
      read += count
    }
    write += count
  }
  if (write !== FRAME_BYTES) throw new Error('画像のサイズが不正です')
  return output
}

export function encodeClip(clip: FlipperClip): Uint8Array {
  if (!Number.isInteger(clip.fps) || clip.fps < 1 || clip.fps > 60 || clip.frames.length < 1 ||
    !Number.isSafeInteger(clip.durationMs) || clip.durationMs < 0 || clip.durationMs > 0xffffffff) {
    throw new Error('FPSまたはフレーム数が不正です')
  }
  const records: Uint8Array[] = []
  let previous: Uint8Array | null = null
  clip.frames.forEach((frame, index) => {
    if (frame.length !== FRAME_BYTES) throw new Error(`フレーム${index}のサイズが不正です`)
    const candidates: { type: number; payload: Uint8Array }[] = [
      { type: 0, payload: frame }, { type: 1, payload: rleEncode(frame) },
    ]
    if (previous && index % (clip.fps * 2) !== 0) {
      const delta = frame.map((byte, i) => byte ^ previous![i])
      candidates.push({ type: 2, payload: delta }, { type: 3, payload: rleEncode(delta) })
    }
    const best = candidates.reduce((a, b) => b.payload.length < a.payload.length ? b : a)
    const record = new Uint8Array(best.payload.length + 3)
    record[0] = best.type
    new DataView(record.buffer).setUint16(1, best.payload.length, true)
    record.set(best.payload, 3)
    records.push(record)
    previous = frame
  })

  const frameIndexOffset = 64
  const frameDataOffset = frameIndexOffset + clip.frames.length * 4
  const audioOffset = frameDataOffset + records.reduce((size, record) => size + record.length, 0)
  if (audioOffset + clip.audio.length * 4 > 0xffffffff) throw new Error('変換データがFZMV形式の4GB上限を超えています')
  const file = new Uint8Array(audioOffset + clip.audio.length * 4)
  const view = new DataView(file.buffer)
  file.set([0x46, 0x5a, 0x4d, 0x56]) // FZMV
  view.setUint16(4, 1, true)
  view.setUint16(6, 64, true)
  view.setUint16(8, WIDTH, true)
  view.setUint16(10, HEIGHT, true)
  view.setUint16(12, clip.fps, true)
  view.setUint16(14, AUDIO_TICK_MS, true)
  view.setUint32(16, clip.frames.length, true)
  view.setUint32(20, clip.audio.length, true)
  view.setUint32(24, frameIndexOffset, true)
  view.setUint32(28, frameDataOffset, true)
  view.setUint32(32, audioOffset, true)
  view.setUint32(36, clip.durationMs, true)
  view.setUint32(40, clip.audio.length ? 1 : 0, true)
  view.setUint32(44, file.length, true)
  let position = frameDataOffset
  records.forEach((record, i) => {
    view.setUint32(frameIndexOffset + i * 4, position, true)
    file.set(record, position)
    position += record.length
  })
  clip.audio.forEach((tick, i) => {
    const offset = audioOffset + i * 4
    view.setUint16(offset, Math.max(0, Math.min(2500, Math.round(tick.frequency))), true)
    view.setUint8(offset + 2, Math.max(0, Math.min(255, Math.round(tick.gain))))
    view.setUint8(offset + 3, Math.max(0, Math.min(100, Math.round(tick.gate))))
  })
  return file
}

export function decodeClip(bytes: Uint8Array): FlipperClip {
  if (bytes.length < 64 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'FZMV') throw new Error('FZMV形式ではありません')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== 64 ||
    view.getUint16(8, true) !== WIDTH || view.getUint16(10, true) !== HEIGHT ||
    view.getUint16(14, true) !== AUDIO_TICK_MS || view.getUint32(44, true) !== bytes.length) {
    throw new Error('非対応のFZMVバージョンまたはヘッダーです')
  }
  const fps = view.getUint16(12, true)
  const frameCount = view.getUint32(16, true)
  const audioCount = view.getUint32(20, true)
  const indexOffset = view.getUint32(24, true)
  const dataOffset = view.getUint32(28, true)
  const audioOffset = view.getUint32(32, true)
  const durationMs = view.getUint32(36, true)
  if (fps === 0 || fps > 60 || frameCount === 0 || indexOffset < 64 || dataOffset < indexOffset + frameCount * 4 ||
    audioOffset < dataOffset || audioOffset + audioCount * 4 !== bytes.length) throw new Error('FZMVのオフセットが不正です')
  const frames: Uint8Array[] = []
  let previous: Uint8Array | null = null
  for (let i = 0; i < frameCount; i++) {
    const position = view.getUint32(indexOffset + i * 4, true)
    if (position < dataOffset || position + 3 > audioOffset) throw new Error('フレームの位置が不正です')
    const mode = bytes[position]
    const length = view.getUint16(position + 1, true)
    if (position + 3 + length > audioOffset || mode > 3) throw new Error('フレームが破損しています')
    const payload = bytes.subarray(position + 3, position + 3 + length)
    const frame = mode & 1 ? rleDecode(payload) : new Uint8Array(payload)
    if (frame.length !== FRAME_BYTES) throw new Error('フレームの長さが不正です')
    if (mode & 2) {
      if (!previous) throw new Error('差分の基準フレームがありません')
      for (let j = 0; j < FRAME_BYTES; j++) frame[j] ^= previous[j]
    }
    frames.push(frame)
    previous = frame
  }
  const audio: BuzzerTick[] = []
  for (let i = 0; i < audioCount; i++) {
    const offset = audioOffset + i * 4
    audio.push({ frequency: view.getUint16(offset, true), gain: bytes[offset + 2], gate: bytes[offset + 3] })
  }
  return { fps, durationMs, frames, audio }
}

export function frameToImageData(frame: Uint8Array, data: ImageData, light: [number, number, number] = [25, 51, 46], dark: [number, number, number] = [167, 190, 158]) {
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    const on = Boolean(frame[i >> 3] & (0x80 >> (i & 7)))
    const color = on ? light : dark
    const offset = i * 4
    data.data[offset] = color[0]
    data.data[offset + 1] = color[1]
    data.data[offset + 2] = color[2]
    data.data[offset + 3] = 255
  }
  return data
}

export function niceBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 ** 2).toFixed(2)} MB`
}
