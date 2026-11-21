import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity, ArrowDownToLine, ArrowRight, AudioLines, Check, ChevronDown,
  CircleAlert, Clock3, Cpu, FileAudio2, FileVideo2, Film, HardDrive,
  Info, MonitorPlay, Pause, Play, RotateCcw, ShieldCheck, SlidersHorizontal,
  Sparkles, UploadCloud, Volume2, Waves, X, Zap,
} from 'lucide-react'
import { convertMedia, type ConversionResult } from './lib/convert'
import { frameToImageData, niceBytes } from './lib/format'
import { playBuzzer, type PlaybackHandle } from './lib/sound'
import type { Settings } from './lib/vision'

const initialSettings: Settings = {
  fps: 10, dither: 'atkinson', contrast: 1.2,
  detail: 40, stability: 40, fit: 'contain', tone: 'melody',
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  return `${Math.floor(safe / 60).toString().padStart(2, '0')}:${(safe % 60).toString().padStart(2, '0')}`
}

function QualitySlider({ label, value, display, min, max, step = 1, onChange, hint }: {
  label: string; value: number; display: string; min: number; max: number; step?: number
  onChange: (value: number) => void; hint: string
}) {
  return <label className="slider-field">
    <span className="slider-heading"><span>{label}</span><strong>{display}</strong></span>
    <input type="range" value={value} min={min} max={max} step={step} onChange={event => onChange(Number(event.target.value))} />
    <small>{hint}</small>
  </label>
}

function ControlSelect({ label, value, choices, onChange }: {
  label: string; value: string | number; choices: { value: string | number; label: string }[]
  onChange: (value: string) => void
}) {
  return <label className="select-field">
    <span>{label}</span>
    <span className="select-wrap"><select value={value} onChange={event => onChange(event.target.value)}>
      {choices.map(choice => <option value={choice.value} key={choice.value}>{choice.label}</option>)}
    </select><ChevronDown size={15} /></span>
  </label>
}

function MiniWave({ audio }: { audio: { gain: number }[] }) {
  return <div className="waveform" aria-hidden="true">
    {Array.from({ length: 62 }, (_, i) => {
      const tick = audio[Math.floor(i / 62 * audio.length)]
      const value = tick?.gain ?? 0
      return <span key={i} style={{ height: `${10 + value / 255 * 85}%` }} />
    })}
  </div>
}

export default function App() {
  const [file, setFile] = useState<File | null>(null)
  const [sourceUrl, setSourceUrl] = useState('')
  const [settings, setSettings] = useState<Settings>(initialSettings)
  const [result, setResult] = useState<ConversionResult | null>(null)
  const [working, setWorking] = useState(false)
  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [dragActive, setDragActive] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const previewCanvas = useRef<HTMLCanvasElement>(null)
  const sourceMedia = useRef<HTMLMediaElement>(null)
  const abortController = useRef<AbortController | null>(null)
  const oscillator = useRef<PlaybackHandle | null>(null)
  const animation = useRef<number>(0)
  const playGeneration = useRef(0)

  const isVideo = Boolean(file && (file.type.startsWith('video/') || /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(file.name)))
  const clip = result?.clip
  const duration = (clip?.durationMs || 0) / 1000

  const stop = useCallback(() => {
    playGeneration.current++
    cancelAnimationFrame(animation.current)
    oscillator.current?.stop()
    oscillator.current = null
    sourceMedia.current?.pause()
    setPlaying(false)
  }, [])

  useEffect(() => {
    if (!file) { setSourceUrl(''); return }
    const url = URL.createObjectURL(file)
    setSourceUrl(url)
    // Media elements can finish their pending range requests after unmount.
    // Keep the blob alive briefly so those requests are not served a revoked URL.
    return () => { window.setTimeout(() => URL.revokeObjectURL(url), 5000) }
  }, [file])

  useEffect(() => () => {
    abortController.current?.abort()
    playGeneration.current++
    cancelAnimationFrame(animation.current)
    oscillator.current?.stop()
  }, [])

  useEffect(() => {
    const canvas = previewCanvas.current
    if (!canvas || !clip) return
    const context = canvas.getContext('2d')
    if (!context) return
    const index = Math.max(0, Math.min(clip.frames.length - 1, Math.floor(position * clip.fps)))
    const pixels = context.createImageData(128, 64)
    context.putImageData(frameToImageData(clip.frames[index], pixels), 0, 0)
  }, [clip, position])

  const chooseFile = (selected?: File) => {
    if (!selected) return
    if (!selected.type.startsWith('video/') && !selected.type.startsWith('audio/') &&
      !/\.(mp4|mov|mkv|webm|avi|m4v|wav|mp3|ogg|m4a|flac|aac)$/i.test(selected.name)) {
      setError('動画または音声ファイルを選択してください。')
      return
    }
    stop()
    // Stop outstanding media fetches before releasing the previous source URL.
    if (sourceMedia.current) {
      sourceMedia.current.removeAttribute('src')
      sourceMedia.current.load()
    }
    abortController.current?.abort()
    setWorking(false)
    setFile(selected)
    setResult(null)
    setPosition(0)
    setProgress(0)
    setError('')
    setStatus('')
  }

  const updateSettings = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings(previous => ({ ...previous, [key]: value }))
    if (result) {
      stop()
      setResult(null)
      setPosition(0)
    }
  }

  const convert = async () => {
    if (!file || working) return
    stop()
    setError('')
    setResult(null)
    setProgress(0)
    const controller = new AbortController()
    abortController.current = controller
    setWorking(true)
    try {
      const converted = await convertMedia(file, settings, controller.signal, (percent, text) => {
        if (!controller.signal.aborted) { setProgress(percent); setStatus(text) }
      })
      if (controller.signal.aborted) return
      setResult(converted)
      setPosition(0)
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
        setError(cause instanceof Error ? cause.message : '変換に失敗しました')
      }
    } finally {
      if (abortController.current === controller) {
        abortController.current = null
        setWorking(false)
      }
    }
  }

  const togglePlayback = async () => {
    if (!clip) return
    if (playing) { stop(); return }
    let startAt = position >= duration - 0.02 ? 0 : position
    if (startAt === 0) setPosition(0)
    const generation = ++playGeneration.current
    try {
      let audio: PlaybackHandle | null = null
      if (clip.audio.length) audio = await playBuzzer(clip.audio, startAt)
      if (generation !== playGeneration.current) { audio?.stop(); return }
      oscillator.current = audio
      const startedAt = performance.now() + (audio ? 60 : 0)
      if (sourceMedia.current) {
        try {
          sourceMedia.current.currentTime = startAt
          sourceMedia.current.muted = true
          await sourceMedia.current.play()
        } catch { /* Source playback isn't required for decoded preview. */ }
      }
      if (generation !== playGeneration.current) { audio?.stop(); return }
      setPlaying(true)
      let lastRendered = -1
      const tick = () => {
        if (generation !== playGeneration.current) return
        const elapsed = audio ? Math.max(0, audio.context.currentTime - audio.start) : Math.max(0, (performance.now() - startedAt) / 1000)
        const now = Math.min(duration, startAt + elapsed)
        if (Math.floor(now * clip.fps) !== Math.floor(lastRendered * clip.fps) || now === duration) { setPosition(now); lastRendered = now }
        if (now >= duration) { stop(); setPosition(duration); return }
        animation.current = requestAnimationFrame(tick)
      }
      animation.current = requestAnimationFrame(tick)
    } catch (cause) {
      stop()
      setError(cause instanceof Error ? cause.message : 'プレビュー音声を開始できませんでした')
    }
  }

  const save = () => {
    if (!result || !file) return
    const blob = new Blob([new Uint8Array(result.binary)], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${file.name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_-]/gu, '_')}.fzmv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return <div className="app-shell">
    <header className="topbar">
      <div className="topbar-inner">
        <a href="#top" className="brand" aria-label="Flipframe Studio トップ">
          <span className="brand-mark"><span className="brand-diagonal" /></span>
          <span>FLIPFRAME<span className="brand-sub">/ STUDIO</span></span>
        </a>
        <div className="header-right"><span className="header-chip"><span className="chip-dot" /> LOCAL ENGINE</span><span className="header-version">BETA v1.0</span></div>
      </div>
    </header>

    <main id="top" className="main-container">
      <div className="hero">
        <div className="hero-content">
          <div className="eyebrow"><span className="eyebrow-square" /> MADE FOR THE 128 × 64 WORLD <span className="eyebrow-line" /></div>
          <h1>すべての瞬間を、<br /><em>ポケットサイズ</em>に。</h1>
          <p>動画と音声を、Flipper Zeroの小さな液晶とブザーへ。<br className="desktop-break" />変換から再生シミュレーションまで、ブラウザひとつで。</p>
          <div className="hero-tags"><span><ShieldCheck size={14} /> ファイルは端末内で処理</span><span><Cpu size={14} /> 128×64 モノクロ</span><span><Volume2 size={14} /> 単音ブザー対応</span></div>
        </div>
        <div className="hero-graphic" aria-hidden="true"><div className="signal-orbit orbit-one" /><div className="signal-orbit orbit-two" /><span className="hero-grid">01011010<br />11000101<br />00110100<br />10101011</span><div className="hero-pixel-card"><div className="hero-pixel-icon">▚</div><span>01 / 64</span></div></div>
      </div>

      <div className="studio-heading"><div><span className="section-kicker">WORKSPACE / 01</span><h2>変換ワークスペース <span>↗</span></h2></div><span className="heading-side">VIDEO + AUDIO PROCESSING</span></div>

      <div className="workspace-grid">
        <aside className="left-column">
          <section className="panel upload-panel">
            <div className="panel-heading"><div className="panel-heading-left"><span className="step-label">01</span><h3>メディアを読み込む</h3></div><span className="panel-detail">INPUT</span></div>
            <input ref={fileInput} type="file" hidden accept="video/*,audio/*,.mkv,.avi,.flac,.mov" onChange={event => { chooseFile(event.target.files?.[0]); event.target.value = '' }} />
            <button className={`drop-zone ${dragActive ? 'drag-active' : ''} ${file ? 'has-file' : ''}`} type="button" onClick={() => fileInput.current?.click()} onDragOver={event => { event.preventDefault(); setDragActive(true) }} onDragLeave={() => setDragActive(false)} onDrop={event => { event.preventDefault(); setDragActive(false); chooseFile(event.dataTransfer.files[0]) }}>
              {file ? <><div className="drop-icon selected">{isVideo ? <FileVideo2 size={24} /> : <FileAudio2 size={24} />}</div><strong className="file-name">{file.name}</strong><span className="drop-secondary">{niceBytes(file.size)} <span className="dot-separator">·</span> クリックして変更</span><span className="file-indicator"><Check size={12} /> ファイル選択済み</span></> : <><div className="drop-icon"><UploadCloud size={27} strokeWidth={1.6} /></div><strong>ファイルをドロップ</strong><span className="drop-secondary">またはクリックしてファイルを選択</span><span className="file-types">MP4 / MOV / WEBM / MP3 / WAV / MORE</span></>}
            </button>
            <div className="upload-footnote"><Info size={14} /> 最後まで変換します。長い動画や高FPSは端末のメモリと処理時間が必要です。</div>
          </section>

          <section className="panel settings-panel">
            <div className="panel-heading"><div className="panel-heading-left"><span className="step-label">02</span><h3>変換パラメータ</h3></div><SlidersHorizontal size={17} className="dim-icon" /></div>
            <div className="settings-group-label"><Film size={15} /> VIDEO <span>映像設定</span></div>
            <div className="settings-selects">
              <ControlSelect label="フレームレート" value={settings.fps} choices={[6, 8, 10, 12, 15, 20, 24, 30, 40, 48, 60].map(value => ({ value, label: `${value} FPS` }))} onChange={value => updateSettings('fps', Number(value))} />
              <div className="full-duration-note"><Clock3 size={14} /> ファイルの最後まで変換します</div>
              <ControlSelect label="ディザリング" value={settings.dither} choices={[{ value: 'atkinson', label: 'Atkinson · 輪郭重視' }, { value: 'floyd', label: 'Floyd–Steinberg · 階調' }, { value: 'bayer', label: 'Ordered 8×8 · 安定' }]} onChange={value => updateSettings('dither', value as Settings['dither'])} />
              <ControlSelect label="画面の収め方" value={settings.fit} choices={[{ value: 'contain', label: '全体を表示' }, { value: 'cover', label: '画面いっぱい' }]} onChange={value => updateSettings('fit', value as Settings['fit'])} />
            </div>
            <div className="settings-sliders">
              <QualitySlider label="コントラスト" value={settings.contrast} display={`${Math.round(settings.contrast * 100)}%`} min={0.7} max={2.2} step={0.05} onChange={value => updateSettings('contrast', value)} hint="淡い映像をくっきり見せる" />
              <QualitySlider label="輪郭の強調" value={settings.detail} display={`${settings.detail}%`} min={0} max={100} onChange={value => updateSettings('detail', value)} hint="細部の視認性を調整" />
              <QualitySlider label="ちらつき抑制" value={settings.stability} display={`${settings.stability}%`} min={0} max={100} onChange={value => updateSettings('stability', value)} hint="連続フレームの表示を安定化" />
            </div>
            <div className="settings-group-label audio-group"><AudioLines size={15} /> AUDIO <span>ブザー設定</span></div>
            <ControlSelect label="音の解析モード" value={settings.tone} choices={[{ value: 'melody', label: 'メロディー優先' }, { value: 'voice', label: '声の帯域を優先' }]} onChange={value => updateSettings('tone', value as Settings['tone'])} />
            <div className="audio-hint"><Waves size={15} /><span>周波数スペクトルから主音を推定。100〜2,500Hzの単音信号に変換します。</span></div>
            {working && <div className="progress-area" role="status"><div className="progress-head"><span>{status}</span><strong>{Math.round(progress * 100)}%</strong></div><div className="progress-track"><div style={{ width: `${progress * 100}%` }} /></div></div>}
            {error && <div className="error-box" role="alert"><CircleAlert size={16} />{error}</div>}
            <button className={`convert-button ${working ? 'converting' : ''}`} onClick={() => { if (working) abortController.current?.abort(); else void convert() }} disabled={!file && !working}>
              {working ? <><X size={17} /> 変換を中止する <span>{Math.round(progress * 100)}%</span></> : <><Zap size={18} fill="currentColor" /> {result ? '設定を変更して再変換' : '変換を開始する'} <ArrowRight size={18} className="button-arrow" /></>}
            </button>
          </section>
        </aside>

        <section className="right-column">
          <div className="panel preview-panel">
            <div className="panel-heading preview-heading"><div className="panel-heading-left"><span className="step-label">03</span><h3>リアルタイムプレビュー</h3></div><span className="preview-status"><span className={`status-light ${clip ? 'ready' : ''}`} />{clip ? 'READY TO PLAY' : 'AWAITING INPUT'}</span></div>
            <div className="preview-grid">
              <div className="preview-section"><div className="preview-label"><span>ORIGINAL</span><span>変換前</span></div>
                <div className="source-stage">{sourceUrl ? (isVideo ? <video key={sourceUrl} ref={element => { sourceMedia.current = element }} controls playsInline preload="metadata" src={sourceUrl} /> : <div className="audio-source"><div className="audio-disc"><AudioLines size={46} /></div><span>ORIGINAL AUDIO</span><audio key={sourceUrl} ref={element => { sourceMedia.current = element }} controls preload="metadata" src={sourceUrl} /></div>) : <div className="empty-source"><Film size={35} strokeWidth={1.3} /><span>メディアを選択すると表示されます</span></div>}</div>
                <div className="preview-caption"><span><span className="caption-pip" /> SOURCE FILE</span><span>{file ? niceBytes(file.size) : '—'}</span></div>
              </div>
              <div className="preview-section converted-section"><div className="preview-label"><span>FLIPPER ZERO <span className="orange-badge">SIMULATED</span></span><span>変換後</span></div>
                <div className="device-stage"><div className="stage-glow" /><div className="flipper-device"><div className="device-upper"><div className="device-display"><div className="display-inner">{clip ? <canvas ref={previewCanvas} width="128" height="64" aria-label="128×64 変換済みプレビュー" /> : <div className="display-idle"><span className="display-idle-icon">▦</span><span>NO SIGNAL</span><i>128 × 64 PX</i></div>}</div></div><div className="device-brand">FLIPFRAME <span>MONO LCD</span></div></div><div className="device-lower"><div className="device-round-button" /><div className="device-dpad"><span>▲</span><span>◀</span><span className="dpad-center">●</span><span>▶</span><span>▼</span></div><div className="device-back-button">↶</div></div></div></div>
                <div className="preview-caption"><span><span className="caption-pip caption-green" /> 128 × 64 / 1-BIT</span><span>{clip ? `${clip.fps} FPS` : '— FPS'}</span></div>
              </div>
            </div>

            <div className="transport"><div className="transport-top"><div className="transport-name"><MonitorPlay size={16} /> CONVERTED PLAYBACK <span>映像・ブザー同期</span></div><span className="transport-time">{formatTime(position)} <span>/</span> {formatTime(duration)}</span></div>
              <div className="transport-bottom"><button className="play-button" disabled={!clip} aria-label={playing ? '一時停止' : '再生'} onClick={() => void togglePlayback()}>{playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}</button><input type="range" className="timeline" aria-label="再生位置" disabled={!clip} min={0} max={Math.max(0.01, duration)} step={0.02} value={position} onChange={event => { stop(); setPosition(Number(event.target.value)) }} style={{ '--seek-progress': `${duration ? position / duration * 100 : 0}%` } as React.CSSProperties} /><button className="replay-button" aria-label="先頭に戻る" disabled={!clip} onClick={() => { stop(); setPosition(0) }}><RotateCcw size={18} /></button></div>
              <div className="transport-wave"><MiniWave audio={clip?.audio || []} /><div className="transport-footnote"><Volume2 size={14} /> ブラウザの音量に注意してください</div></div>
            </div>
          </div>

          <div className="panel export-panel"><div className="export-content"><div className="export-icon"><HardDrive size={22} /></div><div className="export-copy"><span className="export-eyebrow">OUTPUT FILE / .FZMV</span><h3>{clip ? '変換が完了しました' : '書き出しの準備ができています'}</h3><p>{clip ? `${clip.frames.length}フレーム · ${clip.audio.length}音声ステップ · ${niceBytes(result!.binary.length)}` : '変換するとFlipper Zero向け独自ファイルをダウンロードできます。'}</p></div></div><button className="download-button" disabled={!clip} onClick={save}><ArrowDownToLine size={18} /> ダウンロード</button></div>
          {result?.warnings.map((warning, i) => <div className="notice notice-warn" key={i}><CircleAlert size={16} /> {warning}</div>)}
          <div className="spec-grid"><div className="spec"><span className="spec-icon"><MonitorPlay size={18} /></span><span>DISPLAY</span><strong>128 × 64</strong><small>MONOCHROME LCD</small></div><div className="spec"><span className="spec-icon"><Activity size={18} /></span><span>AUDIO</span><strong>100–2500 <i>Hz</i></strong><small>PIEZO BUZZER</small></div><div className="spec"><span className="spec-icon"><Clock3 size={18} /></span><span>FRAME RATE</span><strong>{settings.fps} <i>FPS</i></strong><small>CONFIGURABLE</small></div></div>
        </section>
      </div>

      <div className="bottom-info"><span className="info-icon"><Sparkles size={19} /></span><div><strong>実機再生に向けたプロトタイプ形式</strong><p>FZMV v1は将来の実機プレーヤー用に設計した独自形式です。現時点でFlipper Zero本体の再生アプリは未実装です。60 FPSでの変換・ブラウザ再生には対応していますが、実機で60 FPSを維持できるかは未検証です。LCDの色調とブザーの音色はブラウザによる近似であり、音声は単音に制限されます。</p></div></div>
    </main>
    <footer className="footer"><span className="footer-brand">FLIPFRAME<span> / STUDIO</span></span><span>ENGINE V1.0 <span className="footer-dot">◆</span> LOCAL MEDIA CONVERSION</span><span>BUILT FOR THE TINIEST SCREEN.</span></footer>
  </div>
}
