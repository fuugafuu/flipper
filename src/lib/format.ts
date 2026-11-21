import { PCM_BLOCK_BYTES, PCM_BLOCK_SAMPLES, validateAdpcm, type PcmAudio } from './pcm'

export const WIDTH = 128
export const HEIGHT = 64
export const FRAME_BYTES = WIDTH * HEIGHT / 8
export const AUDIO_TICK_MS = 20
export type BuzzerTick = { frequency: number; gain: number; gate: number }
export type FlipperClip = {
  mode?: 'video-hifi' | 'video-8bit' | 'tracker' | 'all'
  fps: number
  durationMs: number
  frames: Uint8Array[]
  audio: BuzzerTick[]
  pcm?: PcmAudio
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
  if (clip.pcm) {
    if (clip.mode !== 'all' && clip.audio.length) throw new Error('PCMとブザーイベントは同時に格納できません')
    validateAdpcm(clip.pcm)
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
  const audioBytes = (clip.pcm?.data.length ?? 0) + (clip.mode === 'all' ? clip.audio.length * 4 : clip.pcm ? 0 : clip.audio.length * 4)
  if (audioOffset + audioBytes > 0xffffffff) throw new Error('変換データがFZMV形式の4GB上限を超えています')
  const file = new Uint8Array(audioOffset + audioBytes)
  const view = new DataView(file.buffer)
  file.set([0x46, 0x5a, 0x4d, 0x56]) // FZMV
  view.setUint16(4, clip.mode === 'all' ? 4 : clip.mode ? 3 : clip.pcm ? 2 : 1, true)
  view.setUint16(6, 64, true)
  view.setUint16(8, WIDTH, true)
  view.setUint16(10, HEIGHT, true)
  view.setUint16(12, clip.fps, true)
  view.setUint16(14, clip.mode === 'all' ? AUDIO_TICK_MS : clip.pcm ? 0 : AUDIO_TICK_MS, true)
  view.setUint32(16, clip.frames.length, true)
  view.setUint32(20, clip.audio.length, true)
  view.setUint32(24, frameIndexOffset, true)
  view.setUint32(28, frameDataOffset, true)
  view.setUint32(32, audioOffset, true)
  view.setUint32(36, clip.durationMs, true)
  view.setUint32(40, clip.mode === 'all' ? 3 : clip.pcm ? 2 : clip.audio.length ? 1 : 0, true)
  view.setUint32(44, file.length, true)
  if (clip.pcm) {
    view.setUint32(48, clip.pcm.sampleRate, true)
    view.setUint32(52, clip.pcm.sampleCount, true)
    view.setUint16(56, 1, true) // 1 = IMA ADPCM, block-independent
    view.setUint16(58, PCM_BLOCK_SAMPLES, true)
    view.setUint16(60, PCM_BLOCK_BYTES, true)
  }
  if (clip.mode) view.setUint8(62, { 'video-hifi': 0, 'video-8bit': 1, tracker: 2, all: 0 }[clip.mode])
  let position = frameDataOffset
  records.forEach((record, i) => {
    view.setUint32(frameIndexOffset + i * 4, position, true)
    file.set(record, position)
    position += record.length
  })
  if (clip.pcm) file.set(clip.pcm.data, audioOffset)
  clip.audio.forEach((tick, i) => {
    const offset = audioOffset + (clip.pcm?.data.length ?? 0) + i * 4
    view.setUint16(offset, Math.max(0, Math.min(2500, Math.round(tick.frequency))), true)
    view.setUint8(offset + 2, Math.max(0, Math.min(255, Math.round(tick.gain))))
    view.setUint8(offset + 3, Math.max(0, Math.min(100, Math.round(tick.gate))))
  })
  return file
}

export function decodeClip(bytes: Uint8Array): FlipperClip {
  if (bytes.length < 64 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'FZMV') throw new Error('FZMV形式ではありません')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint16(4, true)
  if ((version !== 1 && version !== 2 && version !== 3 && version !== 4) || view.getUint16(6, true) !== 64 ||
    view.getUint16(8, true) !== WIDTH || view.getUint16(10, true) !== HEIGHT ||
    view.getUint16(14, true) !== (version === 2 || (version === 3 && view.getUint32(40, true) === 2) ? 0 : AUDIO_TICK_MS) || view.getUint32(44, true) !== bytes.length) {
    throw new Error('非対応のFZMVバージョンまたはヘッダーです')
  }
  const fps = view.getUint16(12, true)
  const frameCount = view.getUint32(16, true)
  const audioCount = view.getUint32(20, true)
  const indexOffset = view.getUint32(24, true)
  const dataOffset = view.getUint32(28, true)
  const audioOffset = view.getUint32(32, true)
  const durationMs = view.getUint32(36, true)
  const flags = view.getUint32(40, true)
  const isPcm = (version >= 2 && flags === 2) || (version === 4 && view.getUint32(52, true) > 0)
  const mode = version === 4 ? 'all' : version === 3 ? (['video-hifi', 'video-8bit', 'tracker'] as const)[bytes[62]] : undefined
  const pcmBytes = isPcm ? Math.ceil(view.getUint32(52, true) / PCM_BLOCK_SAMPLES) * PCM_BLOCK_BYTES : 0
  const toneOffset = audioOffset + pcmBytes
  if (fps === 0 || fps > 60 || frameCount === 0 || indexOffset < 64 || dataOffset < indexOffset + frameCount * 4 ||
    audioOffset < dataOffset || (version !== 4 && !isPcm && audioOffset + audioCount * 4 !== bytes.length) ||
    (version === 2 && (!isPcm || audioCount !== 0)) || (version === 1 && flags !== (audioCount ? 1 : 0)) ||
    (version === 3 && (!mode || (mode !== 'video-hifi' && isPcm) || (mode === 'video-hifi' && audioCount !== 0) || (isPcm && audioCount !== 0) || (!isPcm && flags !== (audioCount ? 1 : 0)))) ||
    (version === 4 && (flags !== 3 || bytes[62] !== 0 || toneOffset + audioCount * 4 !== bytes.length))) {
    throw new Error('FZMVのオフセットが不正です')
  }
  let pcm: PcmAudio | undefined
  if (isPcm) {
    if (view.getUint16(56, true) !== 1 || view.getUint16(58, true) !== PCM_BLOCK_SAMPLES ||
      view.getUint16(60, true) !== PCM_BLOCK_BYTES || (version === 2 && view.getUint16(62, true) !== 0)) {
      throw new Error('未対応のPCMコーデックです')
    }
    pcm = {
      sampleRate: view.getUint32(48, true),
      sampleCount: view.getUint32(52, true),
      data: bytes.slice(audioOffset, toneOffset),
    }
    validateAdpcm(pcm)
  }
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
    const offset = toneOffset + i * 4
    audio.push({ frequency: view.getUint16(offset, true), gain: bytes[offset + 2], gate: bytes[offset + 3] })
  }
  return { fps, durationMs, frames, audio, ...(pcm ? { pcm } : {}), ...(mode ? { mode } : {}) }
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
