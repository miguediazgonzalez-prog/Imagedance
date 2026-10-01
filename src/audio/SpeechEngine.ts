/** Voz: grabación (MediaRecorder), análisis de audio -> visemas, y visemas desde texto español (casi fonético). */
import type { VisemeFrame } from '../ai/MotionPlanner'
export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } })
  const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(t => MediaRecorder.isTypeSupported(t))
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined), parts: Blob[] = []
  rec.ondataavailable = e => parts.push(e.data); rec.start()
  return { stop: () => new Promise<Blob>(res => { rec.onstop = () => { stream.getTracks().forEach(t => t.stop()); res(new Blob(parts, { type: rec.mimeType })) }; rec.stop() }) }
}
export async function decodeAudio(b: Blob): Promise<AudioBuffer> {
  const ctx = new AudioContext(); try { return await ctx.decodeAudioData(await b.arrayBuffer()) } finally { ctx.close() }
}
export function toMono(b: AudioBuffer): Float32Array {
  const m = new Float32Array(b.length)
  for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) m[i] += d[i] / b.numberOfChannels }
  return m
}
const smooth = (y: number, x: number) => y + (x - y) * (x > y ? 0.6 : 0.3)
/** Audio real -> apertura (RMS con puerta de ruido) + anchura/redondeo (cruces por cero ~ sibilantes vs vocales cerradas). */
export function audioVisemes(buf: AudioBuffer, fps: number, dur: number): VisemeFrame[] {
  const ch = buf.getChannelData(0), hop = buf.sampleRate / fps, n = Math.round(dur * fps), rms: number[] = [], zc: number[] = []
  for (let f = 0; f < n; f++) {
    const s = Math.floor(f * hop), e = Math.min(ch.length, Math.floor((f + 1) * hop)); let a = 0, z = 0
    for (let i = s; i < e; i++) { a += ch[i] * ch[i]; if (i > s && (ch[i] >= 0) !== (ch[i - 1] >= 0)) z++ }
    rms.push(e > s ? Math.sqrt(a / (e - s)) : 0); zc.push(e > s ? z / (e - s) : 0)
  }
  const p95 = Math.max(1e-5, [...rms].sort((a, b) => a - b)[Math.floor(n * 0.95)] || 0)
  let yo = 0, yw = 0.5, yr = 0
  return rms.map((r, f) => {
    const l = r / p95, open = l < 0.08 ? 0 : Math.min(1, l ** 0.8) * 0.85
    yo = smooth(yo, open); yw = yw + (0.5 + Math.min(0.4, Math.max(-0.1, (zc[f] - 0.05) * 2)) - yw) * 0.4
    yr = yr + (Math.min(0.8, open * Math.max(0, 0.06 - zc[f]) * 8) - yr) * 0.4
    return { time: f / fps, mouthOpen: yo, mouthWidth: yw, lipRound: yr }
  })
}
const V: Record<string, [number, number, number]> = { a: [0.8, 0.5, 0], e: [0.5, 0.8, 0], i: [0.25, 1, 0], o: [0.55, 0.3, 0.8], u: [0.3, 0.2, 1], w: [0.2, 0.2, 1], m: [0, 0.5, 0], b: [0, 0.5, 0], p: [0, 0.5, 0], f: [0.12, 0.6, 0], v: [0.12, 0.6, 0] }
/** Texto -> visemas temporizados (~13 letras/s, pausas en puntuación). La voz real de SpeechSynthesis no es capturable: solo se oye en la vista previa. */
export function textVisemes(text: string, fps: number, dur: number, start = 0.5): VisemeFrame[] {
  const t = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''), seg: { d: number; v: [number, number, number] }[] = []
  for (const c of t) seg.push(/[a-zñ]/.test(c) ? { d: 0.075, v: V[c] ?? [0.3, 0.6, 0] } : { d: /[.!?]/.test(c) ? 0.25 : c === ',' ? 0.15 : /\s/.test(c) ? 0.05 : 0, v: [0, 0.5, 0] })
  const total = seg.reduce((s, x) => s + x.d, 0), k = Math.min(1, (dur - start - 0.4) / Math.max(total, 0.01))
  const n = Math.round(dur * fps), out: VisemeFrame[] = []; let i = 0, acc = start, yo = 0, yw = 0.5, yr = 0
  for (let f = 0; f < n; f++) {
    const tm = f / fps; while (i < seg.length - 1 && acc + seg[i].d * k <= tm) acc += seg[i++].d * k
    const on = tm >= start && tm < start + total * k ? seg[i].v : [0, 0.5, 0]
    yo = smooth(yo, on[0]); yw += (on[1] - yw) * 0.4; yr += (on[2] - yr) * 0.4
    out.push({ time: tm, mouthOpen: yo, mouthWidth: yw, lipRound: yr })
  }
  return out
}
export const speakPreview = (text: string) => { if (!('speechSynthesis' in window)) return; speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = 'es-ES'; speechSynthesis.speak(u) }
