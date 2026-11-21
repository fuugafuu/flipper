import type { ImageRegion, Settings } from './vision'

// FFmpeg decodes frames in order, avoiding thousands of individual media seeks.
// Eight-second chunks keep WASM memory bounded even for long 60 FPS videos.
export async function decodeVideoFrames(
  file: File,
  duration: number,
  settings: Settings,
  sourceWidth: number,
  sourceHeight: number,
  signal: AbortSignal,
  onFrame: (index: number, pixels: ImageData, region: ImageRegion) => Promise<void>,
): Promise<void> {
  const [{ FFmpeg }, { fetchFile, toBlobURL }] = await Promise.all([
    import('@ffmpeg/ffmpeg'), import('@ffmpeg/util'),
  ])
  const ffmpeg = new FFmpeg()
  const base = `${import.meta.env.BASE_URL}ffmpeg`
  const extension = file.name.split('.').at(-1)?.replace(/[^a-z0-9]/gi, '') || 'bin'
  const input = `source.${extension}`
  const totalFrames = Math.max(1, Math.ceil(duration * settings.fps))
  const canvasFrame = new ImageData(128, 64)
  const ratio = Math.min(128 / sourceWidth, 64 / sourceHeight)
  const drawWidth = sourceWidth * ratio, drawHeight = sourceHeight * ratio
  const left = (128 - drawWidth) / 2, top = (64 - drawHeight) / 2
  const region: ImageRegion = settings.fit === 'cover'
    ? { left: 0, top: 0, right: 128, bottom: 64 }
    : { left: Math.max(0, Math.ceil(left)), top: Math.max(0, Math.ceil(top)),
        right: Math.min(128, Math.floor(left + drawWidth)), bottom: Math.min(64, Math.floor(top + drawHeight)) }
  const filter = settings.fit === 'cover'
    ? `fps=${settings.fps},scale=128:64:force_original_aspect_ratio=increase,crop=128:64,format=gray`
    : `fps=${settings.fps},scale=128:64:force_original_aspect_ratio=decrease,pad=128:64:(ow-iw)/2:(oh-ih)/2:black,format=gray`

  const abort = () => ffmpeg.terminate()
  signal.addEventListener('abort', abort, { once: true })
  try {
    await ffmpeg.load({
      coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
    })
    if (signal.aborted) throw new DOMException('変換を中止しました', 'AbortError')
    await ffmpeg.writeFile(input, await fetchFile(file))

    // Preserve the picture bounds for exposure estimation inside letterbox bars.
    // The padding has a neutral gray fill only outside the actual picture.
    const width = 128, height = 64
    let lastPixels: Uint8Array | undefined
    const chunkFrames = settings.fps * 8
    for (let first = 0; first < totalFrames; first += chunkFrames) {
      if (signal.aborted) throw new DOMException('変換を中止しました', 'AbortError')
      const frames = Math.min(chunkFrames, totalFrames - first)
      const output = 'frames.raw'
      const start = first / settings.fps
      const code = await ffmpeg.exec([
        '-ss', start.toFixed(6), '-i', input, '-t', (frames / settings.fps).toFixed(6),
        '-an', '-vf', filter, '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'gray', output,
      ])
      if (code !== 0) throw new Error('FFmpegで映像フレームを取得できませんでした')
      const result = await ffmpeg.readFile(output)
      if (typeof result === 'string') throw new Error('映像データを取得できませんでした')
      const bytes = new Uint8Array(result)
      if (bytes.length % (width * height) !== 0) throw new Error('映像データのサイズが不正です')
      const decoded = bytes.length / (width * height)
      if (!decoded && !lastPixels) throw new Error('動画フレームがありません')
      for (let frame = 0; frame < frames; frame++) {
        const gray = frame < decoded
          ? bytes.subarray(frame * width * height, (frame + 1) * width * height)
          : lastPixels!
        for (let pixel = 0; pixel < width * height; pixel++) {
          const offset = pixel * 4
          canvasFrame.data[offset] = gray[pixel]
          canvasFrame.data[offset + 1] = gray[pixel]
          canvasFrame.data[offset + 2] = gray[pixel]
          canvasFrame.data[offset + 3] = 255
        }
        await onFrame(first + frame, canvasFrame, region)
      }
      if (decoded) lastPixels = bytes.slice((decoded - 1) * width * height, decoded * width * height)
      await ffmpeg.deleteFile(output)
    }
  } finally {
    signal.removeEventListener('abort', abort)
    ffmpeg.terminate()
  }
}
