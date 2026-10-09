/** Guion del montaje (módulo puro, sin DOM: se prueba en Node).
 *  Convierte la música (BPM, compases, energía, secciones y drops) en una lista de planos: qué foto y a quién se encuadra, cuánto dura, cómo se mueve la cámara y con qué transición entra. */
import type { DanceCut } from '../ai/MotionPlanner'
import { bodyBox, type Face } from '../ai/People'
import type { Hit } from '../audio/Reactive'
export type Style = 'soft' | 'dynamic' | 'extreme'
export type Trans = 'cut' | 'flash' | 'zoom' | 'whip' | 'glitch' | 'spin'
export type Kind = 'wide' | 'face' | 'pair' | 'detail'
export interface PhotoInfo { W: number; H: number; faces: Face[] }
export interface Shot {
  t0: number; t1: number; photo: number; kind: Kind; focus: number[]
  /** >0 acerca durante el plano; <0 empieza cerca y se aleja. */ push: number
  dir: number; tilt: number; punch: number; trans: Trans; /** duración de la transición de entrada (s) */ tr: number; hot: boolean; finale: boolean
}
export interface Impact { t: number; k: number }
export interface Plan { shots: Shot[]; impacts: Impact[] }
/** Cambio manual de un plano del guion (se aplica encima del guion automático). */
export interface ShotEdit { photo?: number; kind?: Kind; focus?: number[]; trans?: Trans }
export interface PlanOpts {
  photos: PhotoInfo[]; dur: number; bpm: number; offset: number; bar0?: number; cuts?: DanceCut[]; energy?: number[]; fps: number; style: Style; seed?: number
  /** Peso de cada foto (2 = favorita: sale el doble de veces). */ weights?: number[]
  /** Golpes de percusión: en las ráfagas se corta también en ellos, no solo en los beats. */ hits?: Hit[]
  /** Transiciones permitidas (vacío o ausente = automático). */ trans?: Trans[]
  /** Ediciones manuales por nº de plano. */ edits?: Record<number, ShotEdit>
}
const mod4 = (x: number) => ((x % 4) + 4) % 4
const cl = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x))
const rng = (s: number) => () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296)
interface Item { kind: Kind; focus: number[] }
/** Lo que se puede encuadrar de una foto: plano general, cada cara, cada pareja de vecinos y un primerísimo plano. */
function itemsOf(ph: PhotoInfo): Item[] {
  const n = ph.faces.length, it: Item[] = [{ kind: 'wide', focus: [] }]
  for (let i = 0; i < n; i++) it.push({ kind: 'face', focus: [i] })
  for (let i = 0; i < n - 1; i++) it.push({ kind: 'pair', focus: [i, i + 1] })
  if (n) { let big = 0; ph.faces.forEach((f, i) => { if (f.fw > ph.faces[big].fw) big = i }); it.push({ kind: 'detail', focus: [big] }) }
  return it
}
const LEN = { soft: [8, 8, 4], dynamic: [8, 4, 2], extreme: [4, 2, 1] } as const   // beats por plano con energía baja / media / alta
const DROPLEN = { soft: 4, dynamic: 2, extreme: 1 } as const
const POOL: Record<Style, Trans[]> = { soft: ['zoom', 'whip', 'flash'], dynamic: ['zoom', 'whip', 'spin', 'flash', 'glitch'], extreme: ['whip', 'spin', 'zoom', 'glitch', 'cut', 'flash'] }
type Cut = 'drop' | 'sect' | 'hit' | null
function bounds(o: PlanOpts, scale: number) {
  const { dur, bpm, offset, fps } = o, per = 60 / bpm, bs = (bpm >= 150 ? 2 : bpm < 85 ? 0.5 : 1) * scale, cuts = [...(o.cuts ?? [])].sort((a, b) => a.t - b.t)
  const beatT = (j: number) => offset + j * per, isDown = (j: number) => (o.bar0 === undefined ? mod4(j) : mod4(j - o.bar0)) === 0
  const energyAt = (t: number) => (o.energy?.length ? o.energy[Math.min(o.energy.length - 1, Math.max(0, Math.round(t * fps)))] : 0.6)
  const drops = cuts.filter(c => c.drop).map(c => c.t), inDrop = (t: number) => drops.some(d => t >= d - 1e-6 && t < d + 8 * per)
  const out: { t: number; cut: Cut }[] = [{ t: 0, cut: null }]; let t = 0
  for (let g = 0; g < 4000 && t < dur - 1e-6; g++) {
    const e = energyAt(t), L = Math.max(1, Math.round((inDrop(t) ? DROPLEN[o.style] : e >= 0.7 ? LEN[o.style][2] : e >= 0.4 ? LEN[o.style][1] : LEN[o.style][0]) * bs))
    const js = Math.ceil((t - offset) / per - 1e-6); let je = js + L
    if (L >= 4) { let bd = Infinity; for (let j = je - L / 2; j <= je + L / 2; j++) if (j >= js + 2 && isDown(j) && Math.abs(j - je) < bd) { bd = Math.abs(j - je); je = j } }   // los planos largos terminan en primer tiempo de compás
    let tEnd = beatT(je), cut: Cut = null
    for (const c of cuts) {
      const tc = beatT(Math.round((c.t - offset) / per))
      if (tc > t + 0.5 * per && tc < tEnd - 1e-6) { tEnd = tc; cut = c.drop ? 'drop' : 'sect'; break }
      if (Math.abs(tc - tEnd) < 1e-6) cut = c.drop ? 'drop' : 'sect'
    }
    if (cut === null && o.style !== 'soft' && L <= 2) { const h = (o.hits ?? []).find(x => x.k >= 0.5 && x.t > t + 0.45 * per && x.t < tEnd - 0.3 * per); if (h) { tEnd = h.t; cut = 'hit' } }   // ráfagas: también se corta en los golpes de percusión
    if (tEnd > dur - 0.4 * per) tEnd = dur
    out.push({ t: Math.min(tEnd, dur), cut }); t = tEnd
  }
  while (out.length > 2 && dur - out[out.length - 2].t < 1.5 * per) out.splice(out.length - 2, 1)   // el último plano no puede ser un parpadeo
  return { b: out, inDrop, energyAt, per }
}
export function planMontage(o: PlanOpts): Plan {
  const n = Math.max(1, o.photos.length); let B = bounds(o, 1)
  for (let s = 0.5; B.b.length - 1 < n && s > 0.1; s *= 0.5) B = bounds(o, s)   // que cada foto salga al menos una vez
  const { b, inDrop, energyAt, per } = B, rnd = rng(o.seed ?? 11), items = o.photos.map(itemsOf), cur = o.photos.map(() => 0), amp = { soft: 0.5, dynamic: 0.85, extreme: 1.2 }[o.style]
  const wts = o.photos.map((_, i) => Math.max(0.1, o.weights?.[i] ?? 1)), cw = wts.map(() => 0), wsum = wts.reduce((a, b) => a + b, 0)
  const nextPhoto = (prev: number): number => {   // reparto ponderado suave: las favoritas salen más veces, sin repetir foto seguida
    wts.forEach((w, i) => { cw[i] += w }); let pick = -1
    cw.forEach((c, i) => { if ((i !== prev || n < 2) && (pick < 0 || c > cw[pick])) pick = i })
    if (pick < 0) pick = 0; cw[pick] -= wsum; return pick
  }
  const take = (p: number, close: boolean, detail: boolean): Item => {
    const it = items[p]
    for (let g = 0; g < it.length; g++) {
      const c = it[cur[p]++ % it.length]
      if (close && (c.kind === 'wide' || c.kind === 'pair')) continue
      if (!close && c.kind === 'detail' && !detail) continue
      return c
    }
    return it[0]
  }
  let most = 0; o.photos.forEach((p, i) => { if (p.faces.length >= o.photos[most].faces.length) most = i })
  const shots: Shot[] = []; let prev: Trans = 'cut', prevPhoto = -1
  const allowed = o.trans?.length ? o.trans : undefined, pickT = (pool: Trans[]) => { const p = allowed ? pool.filter(x => allowed.includes(x)) : pool, q = p.length ? p : allowed ?? pool; return q[Math.floor(rnd() * q.length)] }
  for (let k = 0; k < b.length - 1; k++) {
    const t0 = b[k].t, t1 = b[k + 1].t, hot = inDrop(t0), last = k === b.length - 2, e = energyAt(t0)
    const photo = last ? most : nextPhoto(prevPhoto), it = last ? { kind: 'wide' as Kind, focus: [] as number[] } : take(photo, hot || (o.style === 'extreme' && e >= 0.7), hot || o.style !== 'soft')
    let trans: Trans = 'cut', tr = 0
    if (k > 0) {
      if (last) trans = pickT(['flash'])
      else if (b[k].cut === 'drop') trans = pickT(o.style === 'extreme' ? ['glitch', 'flash'] : ['flash', 'glitch'])
      else if (b[k].cut === 'hit') trans = pickT(o.style === 'extreme' && rnd() < 0.3 ? ['glitch'] : ['cut'])
      else if (hot) trans = pickT(o.style === 'soft' ? ['zoom'] : rnd() < 0.75 ? ['cut'] : ['glitch'])
      else { const pool = POOL[o.style]; let g = 0; do { trans = pickT(pool) } while (trans === prev && (allowed ? allowed.length : pool.length) > 1 && ++g < 8) }
      tr = trans === 'cut' ? 0 : cl(per * 0.5, 0.12, 0.3); tr = Math.min(tr, 0.4 * (t1 - t0), 0.4 * (t0 - b[k - 1].t))
    }
    prev = trans; prevPhoto = photo
    shots.push({ t0, t1, photo, kind: it.kind, focus: it.focus, push: last ? -0.1 : it.kind === 'wide' ? 0.07 : k % 2 ? 0.1 : -0.05, dir: k % 2 ? 1 : -1, tilt: o.style === 'soft' ? 0 : 0.012 * amp * (rnd() < 0.5 ? -1 : 1) * (hot ? 1.6 : 1), punch: { soft: 0.02, dynamic: 0.04, extreme: 0.07 }[o.style] * (hot ? 1.4 : 1), trans, tr, hot, finale: last })
  }
  applyEdits(shots, o, per)
  const imp = (o.cuts ?? []).map(c => ({ t: Math.max(0, o.offset + Math.round((c.t - o.offset) / per) * per), k: c.drop ? 0.9 : 0.4 })).filter(c => c.t < o.dur)
  b.forEach((x, i) => { if (x.cut === 'hit' && i < b.length - 1) imp.push({ t: x.t, k: 0.25 }) })
  return { shots, impacts: imp }
}
/** Ediciones manuales: foto, tipo de plano (y a quién) y transición; lo que no sea válido para la foto elegida vuelve a plano general. */
function applyEdits(shots: Shot[], o: PlanOpts, per: number) {
  for (const [ks, e] of Object.entries(o.edits ?? {})) {
    const k = +ks, s = shots[k]; if (!s) continue
    if (e.photo !== undefined && e.photo >= 0 && e.photo < o.photos.length) s.photo = e.photo
    if (e.kind) { s.kind = e.kind; s.focus = e.focus ?? s.focus }
    const nf = o.photos[s.photo].faces.length, f = s.focus
    if (s.kind === 'face' && !(f[0] < nf)) { s.kind = 'wide'; s.focus = [] }
    else if (s.kind === 'pair' && !(f.length === 2 && f[1] < nf)) { s.kind = 'wide'; s.focus = [] }
    else if (s.kind === 'detail' && !nf) { s.kind = 'wide'; s.focus = [] }
    else if (s.kind === 'wide') s.focus = []
    if (e.trans && k > 0 && !s.finale) { s.trans = e.trans; s.tr = e.trans === 'cut' ? 0 : Math.min(cl(per * 0.5, 0.12, 0.3), 0.4 * (s.t1 - s.t0), 0.4 * (s.t0 - shots[k - 1].t0)) }
  }
}
/** Plano activo en el instante t (búsqueda binaria). */
export function shotAt(shots: Shot[], t: number): number {
  let lo = 0, hi = shots.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (shots[m].t0 <= t) lo = m; else hi = m - 1 } return lo
}
// ───────────── Cámara ─────────────
export interface Cam { cx: number; cy: number; s: number }
export interface CamState extends Cam { rot: number }
export const coverScale = (p: PhotoInfo, ow: number, oh: number) => Math.max(ow / p.W, oh / p.H)
export const fitScale = (p: PhotoInfo, ow: number, oh: number) => Math.min(ow / p.W, oh / p.H)
/** Mantiene la ventana dentro de la foto; si la ventana es mayor que la foto en un eje, la centra (el resto lo rellena el fondo desenfocado). */
export function clampCam(c: Cam, p: PhotoInfo, ow: number, oh: number): Cam {
  const vw = ow / c.s, vh = oh / c.s
  return { s: c.s, cx: vw >= p.W ? p.W / 2 : cl(c.cx, vw / 2, p.W - vw / 2), cy: vh >= p.H ? p.H / 2 : cl(c.cy, vh / 2, p.H - vh / 2) }
}
const headBox = (f: Face, m = 1.5) => ({ x0: f.cx - 0.9 * f.fw * m, x1: f.cx + 0.9 * f.fw * m, y0: f.cy - 0.9 * f.fw * m, y1: f.cy + 0.9 * f.fw * m })
const union = (bs: { x0: number; x1: number; y0: number; y1: number }[]) => ({ x0: Math.min(...bs.map(b => b.x0)), x1: Math.max(...bs.map(b => b.x1)), y0: Math.min(...bs.map(b => b.y0)), y1: Math.max(...bs.map(b => b.y1)) })
/** Encuadre de reposo de un plano. */
export function restCam(sh: Pick<Shot, 'kind' | 'focus'>, p: PhotoInfo, ow: number, oh: number): Cam {
  const sc = coverScale(p, ow, oh), sf = fitScale(p, ow, oh), top = sc * 3.2
  if (!p.faces.length || sh.kind === 'wide') {
    if (!p.faces.length) return clampCam({ cx: p.W / 2, cy: p.H / 2, s: sc }, p, ow, oh)
    const u = union(p.faces.map(f => headBox(f, 1.15))), w = u.x1 - u.x0, h = u.y1 - u.y0
    return clampCam({ cx: (u.x0 + u.x1) / 2, cy: (u.y0 + u.y1) / 2 + 0.1 * (oh / Math.max(sf, Math.min(sc, ow / w, oh / h))), s: Math.max(sf, Math.min(sc, ow / w, oh / h)) }, p, ow, oh)
  }
  const fs = sh.focus.map(i => p.faces[Math.min(i, p.faces.length - 1)])
  if (sh.kind === 'pair') {
    const u = union(fs.map(f => headBox(f, 1.25))), s = cl(Math.min(ow / (u.x1 - u.x0), oh / (u.y1 - u.y0)), sc * 1.05, top)
    return clampCam({ cx: (u.x0 + u.x1) / 2, cy: (u.y0 + u.y1) / 2 + 0.1 * (oh / s), s }, p, ow, oh)
  }
  const f = fs[0]
  if (sh.kind === 'detail') { const s = cl((ow * 1.05) / f.fw, sc * 1.4, sc * 3.6); return clampCam({ cx: f.cx, cy: f.cy - 0.05 * f.fw, s }, p, ow, oh) }
  const s = cl((ow * 0.66) / f.fw, sc * 1.15, top)
  return clampCam({ cx: f.cx, cy: f.cy + 0.12 * (oh / s), s }, p, ow, oh)
}
const ease = (u: number) => 1 - (1 - u) * (1 - u)
/** Cámara en el instante t: empuje lento durante el plano + golpe de zoom y ladeo en cada beat + deriva lateral. */
export function cameraAt(sh: Shot, rest: Cam, p: PhotoInfo, ow: number, oh: number, t: number, per: number, offset: number, bump = 0): CamState {
  const u = cl((t - sh.t0) / Math.max(1e-6, sh.t1 - sh.t0), 0, 1), e = ease(u), b = (t - offset) / per, ph = b - Math.floor(b)
  const k = sh.push >= 0 ? sh.push * e : -sh.push * (1 - e), punch = sh.punch * Math.exp(-7 * ph)
  const s = rest.s * (1 + k) * (1 + punch) * (1 + bump), c = clampCam({ s, cx: rest.cx + sh.dir * (u - 0.5) * 0.05 * (ow / s), cy: rest.cy }, p, ow, oh)
  return { ...c, rot: sh.tilt * (Math.floor(b) % 2 ? 1 : -1) * Math.exp(-5 * ph) }
}
export { bodyBox }
