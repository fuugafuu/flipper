import { decodeClip, encodeClip, type FlipperClip, type BuzzerTick } from './format'
import { audioArtwork, convertImage, renderSource, type Settings } from './vision'
import { decodeAudio, trackBuzzer } from './sound'
import { pcmWaveform, preparePcm, type PcmAudio } from './pcm'
import { decodeVideoFrames } from './videoFrames'

export type ConversionResult = {
  clip: FlipperClip
  binary: Uint8Array
  warnings: string[]
  sourceDuration: number
}

function abortIfNeeded(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('変換を中止しました', 'AbortError')
}

async function waitForVideo(video: HTMLVideoElement, event: string, timeoutMs = 20000) {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error('動画を読み込めませんでした。形式を確認してください。')) }, timeoutMs)
    const ok = () => { cleanup(); resolve() }
    const fail = () => { cleanup(); reject(new Error('この動画形式はブラウザで再生できません。')) }
    const cleanup = () => {
      clearTimeout(timeout)
      video.removeEventListener(event, ok)
      video.removeEventListener('error', fail)
    }
    video.addEventListener(event, ok, { once: true })
    video.addEventListener('error', fail, { once: true })
  })
}

async function seek(video: HTMLVideoElement, seconds: number, signal: AbortSignal) {
  abortIfNeeded(signal)
  if (Math.abs(video.currentTime - seconds) > 0.002) {
    const seeked = waitForVideo(video, 'seeked', 15000)
    video.currentTime = seconds
    await seeked
  }
  // Allow the browser to present the decoded image before canvas capture.
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  abortIfNeeded(signal)
}

export async function convertMedia(
  file: File,
  settings: Settings,
  signal: AbortSignal,
  onProgress: (progress: number, message: string) => void,
): Promise<ConversionResult> {
  const videoFile = file.type.startsWith('video/') || /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(file.name)
  const video = videoFile ? document.createElement('video') : null
  let videoUrl: string | null = null
  const warnings: string[] = []
  try {
    let sourceDuration = 0
    if (video) {
      videoUrl = URL.createObjectURL(file)
      video.preload = 'auto'
      video.muted = true
      video.playsInline = true
      video.src = videoUrl
      video.load()
      if (video.readyState < 1) await waitForVideo(video, 'loadedmetadata')
      if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('動画の長さを取得できませんでした')
      sourceDuration = video.duration
      if (video.readyState < 2) await waitForVideo(video, 'loadeddata')
    }

    onProgress(0.03, '音声トラックを解析しています')
    let audio: BuzzerTick[] = []
    let pcm: PcmAudio | undefined
    let audioDuration = 0
    try {
      const buffer = await decodeAudio(file, message => onProgress(0.07, message))
      audioDuration = buffer.duration
      if (!video) sourceDuration = buffer.duration
      pcm = await preparePcm(buffer, Math.min(sourceDuration, audioDuration), progress => {
        onProgress(0.1 + progress * 0.16, '高音質トラックを圧縮中 · ADPCM')
      }, signal)
      audio = await trackBuzzer(buffer, Math.min(sourceDuration, audioDuration), { ...settings, mode: 'video-8bit' }, progress => {
        onProgress(0.26 + progress * 0.16, '8bit音声と音程表示用トラックを解析中')
      }, signal)
    } catch (error) {
      abortIfNeeded(signal)
      if (!video) throw error
      warnings.push('音声トラックが存在しないか、音声データの読み取りに失敗しました。映像のみ変換しました。')
    }

    abortIfNeeded(signal)
    const duration = sourceDuration
    const frames: Uint8Array[] = []
    const canvas = document.createElement('canvas')
    canvas.width = 128
    canvas.height = 64
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Canvasを初期化できませんでした')
    // All three playback options share the same video frames and a single tone stream.
    const count = Math.max(1, Math.ceil(duration * settings.fps))
    let previous: Uint8Array | undefined
    let toneState = {}
    const audioLevels = pcm ? pcmWaveform(pcm, Math.max(1, count)) : undefined

    const storeFrame = async (i: number, image: ImageData | Uint8Array, region?: ReturnType<typeof renderSource>) => {
      abortIfNeeded(signal)
      const frame = convertImage(image, settings, previous, region, toneState)
      frames.push(frame)
      previous = frame
      if (i % 48 === 0 || i === count - 1) {
        onProgress(0.43 + ((i + 1) / count) * 0.54, `フレームを最適化中 · ${i + 1} / ${count}`)
        await new Promise(resolve => setTimeout(resolve, 0))
      }
    }

    let decodedFast = false
    if (video) {
      try {
        onProgress(0.43, '高速映像デコーダーを準備しています')
        await decodeVideoFrames(file, duration, settings, video.videoWidth, video.videoHeight, signal, storeFrame)
        decodedFast = frames.length === count
      } catch (error) {
        abortIfNeeded(signal)
        console.warn('Fast video decoding unavailable:', error)
      }
      if (!decodedFast) {
        frames.length = 0
        previous = undefined
        toneState = {}
        onProgress(0.43, 'ブラウザの動画デコーダーで変換しています')
      }
    }
    if (!decodedFast) {
      for (let i = 0; i < count; i++) {
        abortIfNeeded(signal)
        const seconds = i / settings.fps
        let region
        if (video) {
          await seek(video, Math.min(seconds, Math.max(0, sourceDuration - 0.02)), signal)
          region = renderSource(context, video, video.videoWidth, video.videoHeight, settings.fit)
        } else {
          const tick = audio[Math.min(audio.length - 1, Math.floor(seconds * 1000 / 20))]
          audioArtwork(context, count <= 1 ? 0 : i / (count - 1), audioLevels ? audioLevels[i] / 255 : tick ? tick.gain / 255 : 0)
        }
        await storeFrame(i, context.getImageData(0, 0, 128, 64), region)
      }
    }

    if (audioDuration > 0 && audio.length === 0 && !pcm) warnings.push('音声の変換結果は空でした。')
    onProgress(0.98, 'FZMVコンテナを書き出しています')
    const original: FlipperClip = { mode: 'all', fps: settings.fps, durationMs: Math.round(duration * 1000), frames, audio, ...(pcm ? { pcm } : {}) }
    const binary = encodeClip(original)
    // The preview decodes the exported bytes, exactly as a future player should.
    const clip = decodeClip(binary)
    onProgress(1, '変換完了')
    return { clip, binary, warnings, sourceDuration }
  } finally {
    video?.pause()
    video?.removeAttribute('src')
    if (videoUrl) URL.revokeObjectURL(videoUrl)
  }
}
