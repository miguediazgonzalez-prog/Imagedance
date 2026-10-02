/** WebCodecs: prueba H.264 (varios perfiles) -> VP9 -> VP8 y usa el primero que de verdad produzca vídeo. Audio opcional intercalado. */
import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from 'mp4-muxer'
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from 'webm-muxer'
const wait = (ms = 0) => new Promise(r => setTimeout(r, ms))
type Cv = HTMLCanvasElement | OffscreenCanvas
type Aud = { mono: Float32Array; sampleRate: number }
type Cand = { codec: string; kind: 'mp4' | 'webm' }
export interface EncodeOut { blob: Blob; ext: string; audio: boolean; audioNote?: string; audioInfo?: string }
const CANDS: Cand[] = [{ codec: 'avc1.640028', kind: 'mp4' }, { codec: 'avc1.4d0028', kind: 'mp4' }, { codec: 'avc1.42e028', kind: 'mp4' }, { codec: 'vp09.00.10.08', kind: 'webm' }, { codec: 'vp8', kind: 'webm' }]

export async function encodeVideo(canvas: Cv, frames: number, fps: number, draw: (i: number) => void, onProgress: (p: number) => void, audio?: Aud): Promise<EncodeOut> {
  if (!('VideoEncoder' in globalThis)) throw new Error('Este navegador no soporta WebCodecs.')
  const w = canvas.width, h = canvas.height, bitrate = Math.round(w * h * fps * 0.5); let last: unknown
  for (const c of CANDS) {
    const cfg = { codec: c.codec, width: w, height: h, bitrate, framerate: fps, ...(c.kind === 'mp4' ? { avc: { format: 'avc' } } : {}) } as VideoEncoderConfig
    if (!(await VideoEncoder.isConfigSupported(cfg)).supported) continue
    let note: string | undefined
    for (const a of audio ? [audio, undefined] : [undefined]) {
      try { const r = await attempt(canvas, frames, fps, draw, onProgress, c, cfg, a); if (a === undefined && note) r.audioNote = note; return r } catch (e) { last = e; if (a) note = `${c.codec}: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
  throw new Error(last ? `No se pudo codificar el vídeo (${last instanceof Error ? last.message : String(last)}).` : 'No hay códec de vídeo compatible en este dispositivo.')
}

async function attempt(canvas: Cv, frames: number, fps: number, draw: (i: number) => void, onProgress: (p: number) => void, c: Cand, cfg: VideoEncoderConfig, audio?: Aud): Promise<EncodeOut> {
  const mp4 = c.kind === 'mp4', w = canvas.width, h = canvas.height
  let ac: AudioEncoderConfig | undefined, note: string | undefined
  if (audio) {
    if (!('AudioEncoder' in globalThis)) note = `AudioEncoder no existe en ${typeof window === 'undefined' ? 'el worker' : 'la página'}`
    else {
      const a = { codec: mp4 ? 'mp4a.40.2' : 'opus', sampleRate: audio.sampleRate, numberOfChannels: 1, bitrate: 96000, ...(mp4 ? { aac: { format: 'aac' } } : {}) } as AudioEncoderConfig
      try { if ((await AudioEncoder.isConfigSupported(a)).supported) ac = a; else note = `${a.codec} a ${audio.sampleRate} Hz no soportado` } catch (e) { note = `isConfigSupported: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
  const au = ac && { numberOfChannels: 1, sampleRate: audio!.sampleRate }
  const target = mp4 ? new Mp4Target() : new WebmTarget()
  const muxer: any = mp4
    ? new Mp4Muxer({ target: target as Mp4Target, video: { codec: 'avc', width: w, height: h }, audio: au && { codec: 'aac', ...au }, fastStart: 'in-memory' })
    : new WebmMuxer({ target: target as WebmTarget, video: { codec: c.codec.startsWith('vp09') ? 'V_VP9' : 'V_VP8', width: w, height: h, frameRate: fps }, audio: au && { codec: 'A_OPUS', ...au } })
  let err: unknown, vN = 0, aN = 0, cur = 0, key = true, aBytes = 0, adts = false, desc: number | null = null
  // Los muxers leen decoderConfig del primer chunk; si el navegador no lo entrega, fallan al final con "null is not an object".
  const put = (kind: 'v' | 'a', ch: any, m: any) => {
    try {
      if (kind === 'a') {
        aN++; aBytes += ch.byteLength; if (m?.decoderConfig?.description) desc = m.decoderConfig.description.byteLength
        // Si el navegador entrega AAC con cabecera ADTS (7/9 bytes) en vez de AAC crudo, se quita: el MP4 necesita muestras sin ADTS.
        if (mp4) { const d = new Uint8Array(ch.byteLength); ch.copyTo(d); if (d.length > 9 && d[0] === 0xff && (d[1] & 0xf0) === 0xf0) { adts = true; ch = new EncodedAudioChunk({ type: ch.type, timestamp: ch.timestamp, duration: ch.duration ?? undefined, data: d.subarray(d[1] & 1 ? 7 : 9) }) } }
        muxer.addAudioChunk(ch, m); return
      }
      vN++
      if (mp4 && vN === 1 && !m?.decoderConfig?.description) throw new Error('el codificador H.264 no entrega su configuración')
      muxer.addVideoChunk(ch, !mp4 && !m?.decoderConfig ? { ...m, decoderConfig: { codec: c.codec, codedWidth: w, codedHeight: h } } : m)
    } catch (e) { err ??= e }
  }
  const venc = new VideoEncoder({ output: (ch, m) => put('v', ch, m), error: e => (err ??= e) })
  venc.configure(cfg)
  const aenc = ac && new AudioEncoder({ output: (ch, m) => put('a', ch, m), error: e => (err ??= e) })
  aenc?.configure(ac!)
  try {
    for (let i = 0; i < frames; i++) {
      if (err) throw err
      draw(i)
      const f = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) })
      venc.encode(f, { keyFrame: key || i % fps === 0 }); f.close(); key = false
      if (aenc && audio) {
        const end = Math.min(audio.mono.length, Math.round(((i + 1) * audio.sampleRate) / fps))
        if (end > cur) { const a = new AudioData({ format: 'f32-planar', sampleRate: audio.sampleRate, numberOfFrames: end - cur, numberOfChannels: 1, timestamp: Math.round((cur / audio.sampleRate) * 1e6), data: audio.mono.slice(cur, end) }); aenc.encode(a); a.close(); cur = end }
      }
      // Sondeo temprano: si el codificador no produce nada, se aborta en 5 frames en vez de renderizar todo para nada.
      if (i === 4) { await venc.flush(); if (err) throw err; if (!vN) throw new Error('el codificador no produce vídeo'); key = true }
      while (venc.encodeQueueSize > 3) await wait(4)
      onProgress((i + 1) / frames); if (i % 3 === 0) await wait()
    }
    await venc.flush(); await aenc?.flush()
    if (err) throw err
    if (!vN) throw new Error('el codificador no produce vídeo')
    if (ac && !aN) throw new Error('el codificador de audio no produce datos')
    muxer.finalize()
  } finally { for (const e of [venc, aenc]) try { e?.close() } catch { /* ya cerrado */ } }
  return { blob: new Blob([(target as { buffer: ArrayBuffer }).buffer], { type: mp4 ? 'video/mp4' : 'video/webm' }), ext: mp4 ? 'mp4' : 'webm', audio: !!ac, audioNote: ac ? undefined : note,
    audioInfo: ac && audio ? `${ac.codec} ${audio.sampleRate} Hz · ${aN} bloques · ${(aBytes / 1024).toFixed(0)} KB · pico de entrada ${peak(audio.mono).toFixed(2)} · description ${desc ?? 'no'}${adts ? ' · ADTS quitado' : ''}` : undefined }
}

function peak(a: Float32Array) { let m = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > m) m = v } return m }
