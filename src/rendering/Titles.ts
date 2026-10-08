/** Títulos y texto al ritmo: una intro con nombre, frases que entran palabra a palabra con los beats (y se clavan en los drops) y un cierre.
 *  planTitles es puro (se prueba en Node); drawTitles solo usa el contexto 2D, así funciona igual en el Worker. */
import type { DanceCut } from '../ai/MotionPlanner'
export type TitleFont = 'impact' | 'modern' | 'elegant' | 'retro'
export interface TitleCfg { intro: string; sub: string; phrases: string[]; outro: string; font: TitleFont; color: string; accent: string; pos: 'center' | 'bottom' | 'top' }
export const defaultTitles = (): TitleCfg => ({ intro: '', sub: '', phrases: [], outro: '', font: 'impact', color: '#ffffff', accent: '#ff3d81', pos: 'center' })
export const hasTitles = (c: TitleCfg) => !!(c.intro.trim() || c.sub.trim() || c.outro.trim() || c.phrases.some(p => p.trim()))
export interface TitleEvent { kind: 'intro' | 'phrase' | 'outro'; t0: number; t1: number; text: string; sub?: string; words: string[]; /** segundos entre palabra y palabra */ pace: number }
const mod4 = (x: number) => ((x % 4) + 4) % 4
const cl = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x))
const split = (s: string) => s.trim().split(/\s+/).filter(Boolean)
export function planTitles(cfg: TitleCfg, o: { dur: number; bpm: number; offset: number; bar0?: number; cuts?: DanceCut[] }): TitleEvent[] {
  const per = 60 / o.bpm, bar = 4 * per, ev: TitleEvent[] = [], phrases = cfg.phrases.map(p => p.trim()).filter(Boolean)
  const downs = (): number[] => { const a: number[] = []; for (let j = -4; o.offset + j * per < o.dur; j++) if ((o.bar0 === undefined ? mod4(j) : mod4(j - o.bar0)) === 0 && o.offset + j * per >= 0) a.push(o.offset + j * per); return a }
  const D = downs(), nearest = (t: number) => D.reduce((b, d) => (Math.abs(d - t) < Math.abs(b - t) ? d : b), D[0] ?? t)
  let from = 0
  if (cfg.intro.trim() || cfg.sub.trim()) {
    const len = cl(2 * bar, 1.6, Math.min(5, 0.35 * o.dur)), t0 = 0.15
    ev.push({ kind: 'intro', t0, t1: Math.min(o.dur - 0.5, t0 + len), text: cfg.intro.trim(), sub: cfg.sub.trim() || undefined, words: split(cfg.intro), pace: per / 2 }); from = ev[0].t1 + 0.5 * bar
  }
  let end = o.dur - 0.9
  if (cfg.outro.trim()) { const len = cl(2 * bar, 1.8, 4.5), t1 = o.dur - 0.35, t0 = Math.max(from, t1 - len); if (t1 - t0 > 0.8) { ev.push({ kind: 'outro', t0, t1, text: cfg.outro.trim(), words: split(cfg.outro), pace: per / 2 }); end = t0 - 0.3 } }
  const start = Math.max(from, bar), room = Math.floor((end - start) / (0.9 * bar)), n = Math.min(phrases.length, Math.max(0, room))
  const drops = (o.cuts ?? []).filter(c => c.drop).map(c => c.t); let prev = -Infinity
  for (let i = 0; i < n; i++) {
    const slot = (end - start) / n; let t0 = nearest(start + i * slot)
    const dr = drops.find(d => Math.abs(d - t0) < 1.5 * bar && d > prev); if (dr !== undefined) t0 = nearest(dr)   // la frase cae justo en el drop
    const dn = D.find(d => d >= Math.max(t0, prev + 0.2, start) - 1e-6); if (dn === undefined) break; t0 = dn; const len = Math.min(2 * bar, slot - 0.25 * per), t1 = Math.min(end, t0 + Math.max(0.75 * bar, len))
    if (t1 - t0 < 0.5 * bar) continue
    const words = split(phrases[i]); ev.push({ kind: 'phrase', t0, t1, text: phrases[i], words, pace: Math.max(per / 2, Math.min(per, (0.7 * (t1 - t0)) / Math.max(1, words.length))) }); prev = t1
  }
  return ev.sort((a, b) => a.t0 - b.t0)
}
const FONTS: Record<TitleFont, { family: string; weight: string; style: string; upper: boolean; stroke: number }> = {
  impact: { family: 'Impact, Haettenschweiler, "Arial Narrow Bold", "Arial Black", sans-serif', weight: '900', style: 'normal', upper: true, stroke: 0.12 },
  modern: { family: 'ui-rounded, "SF Pro Rounded", "Segoe UI", system-ui, sans-serif', weight: '900', style: 'normal', upper: true, stroke: 0.1 },
  elegant: { family: 'Georgia, "Times New Roman", serif', weight: '700', style: 'italic', upper: false, stroke: 0.05 },
  retro: { family: 'ui-monospace, Menlo, Consolas, monospace', weight: '800', style: 'normal', upper: true, stroke: 0.1 }
}
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
/** Reparte las palabras en líneas de ancho ≤ maxW (medido a tamaño S). */
function layout(c: Ctx, words: string[], S: number, maxW: number) {
  const sp = c.measureText(' ').width, wd = words.map(w => c.measureText(w).width), lines: { idx: number[]; w: number }[] = []; let cur = { idx: [] as number[], w: 0 }
  words.forEach((_, i) => { const add = (cur.idx.length ? sp : 0) + wd[i]; if (cur.idx.length && cur.w + add > maxW) { lines.push(cur); cur = { idx: [], w: 0 } } cur.w += (cur.idx.length ? sp : 0) + wd[i]; cur.idx.push(i) })
  if (cur.idx.length) lines.push(cur); return { lines, wd, sp, lh: 1.1 * S }
}
/** Dibuja los títulos activos en el instante t. */
export function drawTitles(c: Ctx, events: TitleEvent[], t: number, cfg: TitleCfg, ow: number, oh: number, per: number, offset: number) {
  const f = FONTS[cfg.font], u = Math.min(ow, oh), b = (t - offset) / per, ph = b - Math.floor(b), punch = 1 + 0.045 * Math.exp(-7 * ph)
  for (const e of events) {
    const age = t - e.t0; if (age < 0 || t > e.t1) continue
    const fade = cl((e.t1 - t) / 0.35, 0, 1), out = 1 + (1 - fade) * 0.15, show = (s: string) => (f.upper ? s.toUpperCase() : s)
    const words = (e.kind === 'intro' ? split(e.text) : e.words).map(show); if (!words.length && !e.sub) continue
    let S = (e.kind === 'intro' ? 0.15 : 0.1) * u; const maxW = 0.86 * ow
    c.save(); c.textAlign = 'left'; c.textBaseline = 'middle'; c.lineJoin = 'round'
    const font = (s: number) => `${f.style} ${f.weight} ${Math.round(s)}px ${f.family}`
    c.font = font(S)
    if (e.kind === 'intro' && words.length) { const wAll = c.measureText(words.join(' ')).width; if (wAll > maxW) { S *= maxW / wAll; c.font = font(S) } }
    const L = layout(c, words, S, maxW), H = L.lines.length * L.lh, cy = (cfg.pos === 'top' ? 0.2 : cfg.pos === 'bottom' ? 0.78 : e.kind === 'intro' ? 0.45 : 0.5) * oh
    c.translate(ow / 2, cy); c.scale(punch * out, punch * out)
    const shown = Math.min(words.length, Math.floor(age / e.pace) + 1)
    L.lines.forEach((ln, li) => {
      let x = -ln.w / 2; const y = -H / 2 + (li + 0.5) * L.lh
      for (const i of ln.idx) {
        const a = age - i * e.pace, w = L.wd[i]
        if (i < shown && a >= 0) {
          const pop = 1 + 0.5 * Math.exp(-a * 13), al = Math.min(1, a * 14) * fade, dy = (1 - Math.min(1, a * 9)) * 0.05 * oh, last = i === shown - 1 && e.kind !== 'intro' && a < 0.3
          c.save(); c.translate(x + w / 2, y + dy); c.scale(pop, pop); c.globalAlpha = al; c.textAlign = 'center'
          c.shadowColor = 'rgba(0,0,0,0.55)'; c.shadowBlur = S * 0.18; c.strokeStyle = 'rgba(0,0,0,0.7)'; c.lineWidth = S * f.stroke; c.strokeText(words[i], 0, 0)
          c.shadowBlur = 0; c.fillStyle = last ? cfg.accent : cfg.color; c.fillText(words[i], 0, 0); c.restore()
        }
        x += w + L.sp
      }
    })
    if (e.kind === 'intro') {
      const bw = Math.min(0.5 * maxW, Math.max(...L.lines.map(l => l.w), 0) * 0.5) * (1 - Math.exp(-age * 4)), by = H / 2 + 0.16 * S
      c.globalAlpha = fade; c.fillStyle = cfg.accent; if (words.length) c.fillRect(-bw / 2, by, bw, Math.max(3, S * 0.05))
      if (e.sub && age > 0.45) {
        const s2 = 0.36 * S, a2 = Math.min(1, (age - 0.45) * 5) * fade; c.font = font(s2); c.textAlign = 'center'; c.globalAlpha = a2; c.shadowColor = 'rgba(0,0,0,0.6)'; c.shadowBlur = s2 * 0.3
        c.strokeStyle = 'rgba(0,0,0,0.7)'; c.lineWidth = s2 * 0.1; c.strokeText(show(e.sub), 0, by + 0.9 * s2 + S * 0.1); c.shadowBlur = 0; c.fillStyle = cfg.color; c.fillText(show(e.sub), 0, by + 0.9 * s2 + S * 0.1)
      }
    }
    c.restore()
  }
}
