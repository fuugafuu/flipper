/** IMA ADPCM, independently decodable blocks for SD-card streaming and seeking. */
export const PCM_SAMPLE_RATE = 16000
export const PCM_BLOCK_SAMPLES = 256
export const PCM_BLOCK_BYTES = 132

export type PcmAudio = {
  sampleRate: number
  sampleCount: number
  data: Uint8Array
}

const steps = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31,
  34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143,
  157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544,
  598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707,
  1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871,
  5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
  15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
]
const indexDelta = [-1, -1, -1, -1, 2, 4, 6, 8]

function clamp(value: number, low: number, high: number) {
  return Math.max(low, Math.min(high, value))
}

function stepPredict(predictor: number, index: number, nibble: number) {
  const step = steps[index]
  const difference = (step >> 3) + ((nibble & 1) ? step >> 2 : 0) +
    ((nibble & 2) ? step >> 1 : 0) + ((nibble & 4) ? step : 0)
  return {
    predictor: clamp(predictor + ((nibble & 8) ? -difference : difference), -32768, 32767),
    index: clamp(index + indexDelta[nibble & 7], 0, 88),
  }
}

/** Each 132-byte block starts with signed LE predictor, index, zero padding.
 * The predictor is the first PCM sample. The following 255 samples are packed
 * low-nibble-first, with the final unused high nibble set to zero. */
export function encodeAdpcm(samples: Int16Array): PcmAudio {
  const count = Math.ceil(samples.length / PCM_BLOCK_SAMPLES)
  const data = new Uint8Array(count * PCM_BLOCK_BYTES)
  const view = new DataView(data.buffer)
  for (let block = 0; block < count; block++) {
    const start = block * PCM_BLOCK_SAMPLES
    const base = block * PCM_BLOCK_BYTES
    let predictor = samples[start]
    // Estimate a starting quantizer step for every independently seekable block.
    // Starting at index zero on every 16ms block creates audible bursts on music.
    const window = Math.min(25, samples.length - start)
    let movement = 0
    for (let i = 1; i < window; i++) movement += Math.abs(samples[start + i] - samples[start + i - 1])
    const initialStep = window > 1 ? movement / (window - 1) * 0.6 : 7
    let index = 0
    while (index < 88 && steps[index] < initialStep) index++
    view.setInt16(base, predictor, true)
    data[base + 2] = index
    for (let i = 1; i < Math.min(PCM_BLOCK_SAMPLES, samples.length - start); i++) {
      const step = steps[index]
      let difference = samples[start + i] - predictor
      let nibble = 0
      if (difference < 0) { nibble = 8; difference = -difference }
      if (difference >= step) { nibble |= 4; difference -= step }
      if (difference >= step / 2) { nibble |= 2; difference -= step / 2 }
      if (difference >= step / 4) nibble |= 1
      const byteOffset = base + 4 + ((i - 1) >> 1)
      if (i % 2) data[byteOffset] = nibble
      else data[byteOffset] |= nibble << 4
      const state = stepPredict(predictor, index, nibble)
      predictor = state.predictor
      index = state.index
    }
  }
  return { sampleRate: PCM_SAMPLE_RATE, sampleCount: samples.length, data }
}

export function validateAdpcm(pcm: PcmAudio) {
  if (pcm.sampleRate !== PCM_SAMPLE_RATE || !Number.isSafeInteger(pcm.sampleCount) ||
    pcm.sampleCount < 1 || pcm.sampleCount > 0xffffffff ||
    pcm.data.length !== Math.ceil(pcm.sampleCount / PCM_BLOCK_SAMPLES) * PCM_BLOCK_BYTES) {
    throw new Error('IMA ADPCM音声データが不正です')
  }
}

export function decodeAdpcm(pcm: PcmAudio): Int16Array {
  validateAdpcm(pcm)
  const samples = new Int16Array(pcm.sampleCount)
  const view = new DataView(pcm.data.buffer, pcm.data.byteOffset, pcm.data.byteLength)
  for (let block = 0; block < Math.ceil(pcm.sampleCount / PCM_BLOCK_SAMPLES); block++) {
    const base = block * PCM_BLOCK_BYTES
    const start = block * PCM_BLOCK_SAMPLES
    let predictor = view.getInt16(base, true)
    let index = pcm.data[base + 2]
    if (index > 88 || pcm.data[base + 3] !== 0) throw new Error('IMA ADPCMブロックが破損しています')
    samples[start] = predictor
    for (let i = 1; i < Math.min(PCM_BLOCK_SAMPLES, pcm.sampleCount - start); i++) {
      const nibbleByte = pcm.data[base + 4 + ((i - 1) >> 1)]
      const nibble = (i % 2) ? nibbleByte & 0x0f : nibbleByte >> 4
      const state = stepPredict(predictor, index, nibble)
      predictor = state.predictor
      index = state.index
      samples[start + i] = predictor
    }
  }
  return samples
}

export function pcmWaveform(pcm: PcmAudio, bars = 62): number[] {
  const samples = decodeAdpcm(pcm)
  return Array.from({ length: bars }, (_, i) => {
    const from = Math.floor(i * samples.length / bars)
    const to = Math.max(from + 1, Math.floor((i + 1) * samples.length / bars))
    let sum = 0
    for (let j = from; j < to; j++) sum += samples[j] * samples[j]
    return Math.min(255, Math.round(Math.sqrt(sum / (to - from)) / 32768 * 450))
  })
}

function resampleAudio(buffer: AudioBuffer, seconds: number): Float32Array {
  const size = Math.floor(Math.min(seconds, buffer.duration) * PCM_SAMPLE_RATE)
  const target = new Float32Array(size)
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i))
  const ratio = buffer.sampleRate / PCM_SAMPLE_RATE
  if (!channels.length) return target
  // 16-tap windowed-sinc low-pass, cutoff scales with the resampling ratio.
  // Video audio has already been resampled by FFmpeg to 16 kHz.
  const radius = Math.ceil(8 * Math.max(1, ratio))
  const cutoff = 0.47 / Math.max(1, ratio)
  for (let i = 0; i < size; i++) {
    const center = (i + 0.5) * ratio - 0.5
    const left = Math.max(0, Math.ceil(center - radius))
    const right = Math.min(channels[0].length - 1, Math.floor(center + radius))
    let sum = 0
    let weight = 0
    for (let j = left; j <= right; j++) {
      const distance = j - center
      const sinc = distance ? Math.sin(2 * Math.PI * cutoff * distance) / (Math.PI * distance) : 2 * cutoff
      const window = 0.5 + 0.5 * Math.cos(Math.PI * distance / radius)
      const coefficient = sinc * window
      let mixed = 0
      for (const channel of channels) mixed += channel[j] / channels.length
      sum += mixed * coefficient
      weight += coefficient
    }
    target[i] = weight ? sum / weight : 0
  }
  return target
}

/** Limit sub-bass that the piezo cannot reproduce, control peaks and encode
 * full-band audio so drums, harmonies and spoken words remain distinguishable. */
export async function preparePcm(
  buffer: AudioBuffer, seconds: number,
  onProgress: (progress: number) => void, signal: AbortSignal,
): Promise<PcmAudio> {
  const samples = resampleAudio(buffer, seconds)
  if (!samples.length) throw new Error('PCM音声が空です')
  const alpha = Math.exp(-2 * Math.PI * 210 / PCM_SAMPLE_RATE)
  const lowPass = 1 - Math.exp(-2 * Math.PI * 5400 / PCM_SAMPLE_RATE)
  let priorIn = 0
  let priorHigh = 0
  let priorHigh2 = 0
  let priorLow = 0
  let rmsSum = 0
  for (let i = 0; i < samples.length; i++) {
    const input = samples[i]
    const high = alpha * (priorHigh + input - priorIn)
    const high2 = alpha * (priorHigh2 + high - priorHigh)
    priorIn = input
    priorHigh = high
    priorHigh2 = high2
    priorLow += lowPass * (high2 - priorLow)
    samples[i] = priorLow
    rmsSum += priorLow * priorLow
    if (i % 262144 === 0) {
      if (signal.aborted) throw new DOMException('変換を中止しました', 'AbortError')
      onProgress(i / samples.length * 0.5)
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }
  const rms = Math.sqrt(rmsSum / samples.length)
  const normalize = rms > 0.0001 ? Math.min(9, 0.28 / rms) : 1
  const output = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    // The soft-knee avoids hard clipping on drum transients.
    output[i] = Math.round(Math.tanh(samples[i] * normalize * 1.3) * 31000)
    if (i % 262144 === 0) {
      if (signal.aborted) throw new DOMException('変換を中止しました', 'AbortError')
      onProgress(0.5 + i / samples.length * 0.5)
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }
  onProgress(1)
  return encodeAdpcm(output)
}
