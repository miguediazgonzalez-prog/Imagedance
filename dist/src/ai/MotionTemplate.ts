/** Plantilla de movimiento: los movimientos de una persona en un vídeo (cabeza, expresión y torso) guardados como curvas por fotograma, independientes de la foto,
 *  para reproducirlos sobre cualquier otra foto con el mismo WarpRenderer. Este módulo es puro (sin DOM ni MediaPipe) para poder probarlo aparte;
 *  la extracción desde un vídeo está en VideoTracker.ts.
 *
 *  Convenciones de la plantilla (las que se ven en pantalla, no las internas del renderer):
 *   yaw: + = la nariz va hacia la derecha de la pantalla · pitch: + = la barbilla baja · roll: + = giro horario · lean: + = el torso se inclina a la derecha
 *   sway, bob: en anchos de cara (+ = derecha / abajo) · zoom: 1 = tamaño neutro · el resto (parpadeo, boca, cejas, mirada) ya va en las unidades de FacialMotion. */
import type { Pt } from './FaceLandmarks'
import { danceAt, type BodyMotion, type DanceSpec, type FacialMotion } from './MotionPlanner'
import { armRot, wrapPi, type ArmRig } from './ArmSkin'

export const CH = ['yaw', 'pitch', 'roll', 'blinkL', 'blinkR', 'lookX', 'lookY', 'smile', 'open', 'browL', 'browR', 'width', 'round', 'lean', 'sway', 'bob', 'zoom', 'uL', 'fL', 'hL', 'uR', 'fR', 'hR'] as const
/** Canales de brazos (ángulos absolutos desde "recto hacia abajo", + = derecha de pantalla; hL/hR = mano relativa al antebrazo). L/R = lado de la PANTALLA en el vídeo. Opcionales al abrir plantillas antiguas. */
const ARM_CH: Ch[] = ['uL', 'fL', 'hL', 'uR', 'fR', 'hR']
export type Ch = (typeof CH)[number]
export interface MotionTemplate {
  v: 1; name: string; fps: number; n: number; dur: number
  /** true = se vio el torso (pose); false = el cuerpo se deduce solo de la posición de la cara */
  hasBody: boolean
  /** Qué brazos se vieron en el vídeo (lado de la pantalla). */
  armL?: boolean; armR?: boolean
  ch: Record<Ch, Float32Array>
  /** Duración (s) de un ciclo de movimiento repetido (el paso), su fiabilidad 0..1 y el instante del ciclo en que el cuerpo está más abajo (el "golpe"). */
  period?: number; periodConf?: number; phase?: number
}

/** Landmarks de MediaPipe poco afectados por la expresión (frente, sienes, pómulos, puente de la nariz, esquinas de los ojos): con ellos se ajusta la rotación de la cabeza. */
export const RIGID = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 93, 234, 127, 162, 21, 54, 103, 67, 109, 132, 361, 1, 2, 4, 5, 6, 168, 197, 195, 193, 417, 122, 351, 33, 133, 263, 362]

/** Deben coincidir con YAW_RAD y PITCH_RAD de WarpRenderer.ts (radianes por unidad de headYaw / headPitch). */
const YAW_RAD = 0.35, PITCH_RAD = 0.3
const cl = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x))
const mod = (x: number, d: number) => ((x % d) + d) % d
const ss = (x: number) => { const t = cl(x); return t * t * (3 - 2 * t) }

// ───────────── Rotación 3D: ajuste (Kabsch) y descomposición en los ángulos del renderer ─────────────
export type M3 = number[]   // 3×3 por filas
const I3: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]
export const mul3 = (a: M3, b: M3): M3 => { const o = new Array<number>(9).fill(0); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[3 * i + j] += a[3 * i + k] * b[3 * k + j]; return o }
const T3 = (m: M3): M3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]
const det3 = (m: M3) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])
function inv3(m: M3): M3 | null {
  const d = det3(m); if (Math.abs(d) < 1e-12) return null
  const [a, b, c, d2, e, f, g, h, i] = m
  return [(e * i - f * h) / d, (c * h - b * i) / d, (b * f - c * e) / d, (f * g - d2 * i) / d, (a * i - c * g) / d, (c * d2 - a * f) / d, (d2 * h - e * g) / d, (b * g - a * h) / d, (a * e - b * d2) / d]
}
/** Factor ortogonal de la descomposición polar (iteración de Newton). Si el determinante no es positivo (datos degenerados) devuelve la identidad. */
export function polar(C: M3): M3 {
  if (det3(C) <= 0) return I3
  const s = Math.hypot(...C); let X = C.map(v => v / s)
  for (let it = 0; it < 50; it++) {
    const iv = inv3(X); if (!iv) break
    const Y = T3(iv), Xn = X.map((v, i) => 0.5 * (v + Y[i])); let d = 0; for (let i = 0; i < 9; i++) d += Math.abs(Xn[i] - X[i])
    X = Xn; if (d < 1e-12) break
  }
  return X
}
/** Rotación R que mejor lleva los puntos N (centrados y a escala 1) a F: F ≈ R·N. Ambos son [x,y,z,x,y,z,…]. */
export function fitRotation(N: ArrayLike<number>, F: ArrayLike<number>): M3 {
  const C = new Array<number>(9).fill(0), k = Math.floor(N.length / 3)
  for (let i = 0; i < k; i++) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[3 * a + b] += F[3 * i + a] * N[3 * i + b]
  return polar(C)
}
/** Rotación del renderer: guiñada (ya) → cabeceo (pa) → alabeo (r), tal como la aplica WarpRenderer.project(): M = Rz·Rx·Ry. */
export function composeRenderer(ya: number, pa: number, r: number): M3 {
  const cy = Math.cos(ya), sy = Math.sin(ya), cp = Math.cos(pa), sp = Math.sin(pa), cr = Math.cos(r), sr = Math.sin(r)
  return mul3([cr, -sr, 0, sr, cr, 0, 0, 0, 1], mul3([1, 0, 0, 0, cp, sp, 0, -sp, cp], [cy, 0, sy, 0, 1, 0, -sy, 0, cy]))
}
export function toRendererAngles(M: M3): { ya: number; pa: number; r: number } {
  return { ya: Math.atan2(-M[6], M[8]), pa: Math.asin(cl(-M[7], -1, 1)), r: Math.atan2(-M[1], M[4]) }
}
/** Centra los puntos en su centroide y los escala a radio cuadrático medio 1 (así da igual lo cerca que esté la persona de la cámara). */
export function normalizePts(p: ArrayLike<number>): { q: Float32Array; c: [number, number, number]; s: number } {
  const k = Math.floor(p.length / 3), c: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < k; i++) for (let a = 0; a < 3; a++) c[a] += p[3 * i + a] / k
  const q = new Float32Array(3 * k); let s2 = 0
  for (let i = 0; i < k; i++) for (let a = 0; a < 3; a++) { const v = p[3 * i + a] - c[a]; q[3 * i + a] = v; s2 += v * v }
  const s = Math.sqrt(s2 / k) || 1; for (let i = 0; i < q.length; i++) q[i] /= s
  return { q, c, s }
}

// ───────────── Construcción de la plantilla a partir de lo medido en cada fotograma ─────────────
/** Ángulos medidos de un brazo en un fotograma: brazo (u), antebrazo (f) y mano relativa al antebrazo (hd, si se ve). */
export interface ArmAng { u: number; f: number; hd?: number }
export interface RawFrame {
  /** pts = RIGID en píxeles (x,y,z intercalados); fw = ancho de cara (px); cx, cy = centro de la cara (px); bs = blendshapes de MediaPipe por nombre. */
  face?: { pts: Float32Array; fw: number; cx: number; cy: number; bs: Record<string, number> }
  /** Hombros (centro, ancho, inclinación de la línea de hombros en rad) y, si se ven las caderas, su centro. Todo en píxeles. */
  pose?: { sx: number; sy: number; sw: number; tilt: number; hx?: number; hy?: number; arms?: { l?: ArmAng; r?: ArmAng } }
}
const median = (a: ArrayLike<number>) => { const s = Array.from(a).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0 }
/** Rellena huecos (fotogramas sin detección) interpolando; los extremos repiten el valor más cercano. */
export function fillGaps(v: (number | undefined)[]): Float32Array {
  const n = v.length, o = new Float32Array(n), idx: number[] = []
  v.forEach((x, i) => { if (x !== undefined && Number.isFinite(x)) idx.push(i) })
  if (!idx.length) return o
  for (let i = 0; i < n; i++) {
    if (v[i] !== undefined && Number.isFinite(v[i])) { o[i] = v[i]!; continue }
    let a = -1, b = -1; for (const j of idx) { if (j < i) a = j; else { b = j; break } }
    o[i] = a < 0 ? v[b]! : b < 0 ? v[a]! : v[a]! + (v[b]! - v[a]!) * ((i - a) / (b - a))
  }
  return o
}
/** Suavizado gaussiano (sigma en fotogramas); los bordes repiten el último valor. */
export function gauss(a: Float32Array, sigma: number): Float32Array {
  if (sigma <= 0.05) return a
  const r = Math.ceil(3 * sigma), k: number[] = []; let sum = 0
  for (let i = -r; i <= r; i++) { const w = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(w); sum += w }
  const o = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++) { let s = 0; for (let j = -r; j <= r; j++) s += k[j + r] * a[Math.min(a.length - 1, Math.max(0, i + j))]; o[i] = s / sum }
  return o
}
const sub = (a: Float32Array, m: number) => { for (let i = 0; i < a.length; i++) a[i] -= m; return a }
const bsv = (b: Record<string, number>, k: string) => b[k] ?? 0
/** Blendshapes de MediaPipe → controles de FacialMotion. "Left/Right" son los del sujeto, igual que eyeBlinkLeft/Right del renderer. */
export function expressionFrom(b: Record<string, number>) {
  const smileL = bsv(b, 'mouthSmileLeft'), smileR = bsv(b, 'mouthSmileRight'), smile = cl((smileL + smileR) / 2 / 0.6), pucker = Math.max(bsv(b, 'mouthPucker'), 0.8 * bsv(b, 'mouthFunnel'))
  const brow = (side: 'Left' | 'Right') => cl(0.6 * bsv(b, 'browInnerUp') + 0.7 * bsv(b, 'browOuterUp' + side) - 0.9 * bsv(b, 'browDown' + side), -0.6, 1)
  return {
    blinkL: cl((bsv(b, 'eyeBlinkLeft') - 0.1) / 0.7), blinkR: cl((bsv(b, 'eyeBlinkRight') - 0.1) / 0.7),
    lookX: cl(((bsv(b, 'eyeLookOutLeft') + bsv(b, 'eyeLookInRight')) - (bsv(b, 'eyeLookInLeft') + bsv(b, 'eyeLookOutRight'))) / 2, -1, 1),   // + = hacia la derecha de la pantalla
    lookY: cl(((bsv(b, 'eyeLookDownLeft') + bsv(b, 'eyeLookDownRight')) - (bsv(b, 'eyeLookUpLeft') + bsv(b, 'eyeLookUpRight'))) / 2, -1, 1),   // + = hacia abajo
    smile, open: cl(bsv(b, 'jawOpen') / 0.6), browL: brow('Left'), browR: brow('Right'),
    width: cl(0.5 + 0.35 * smile - 0.45 * pucker), round: cl(pucker / 0.7)
  }
}

export function buildTemplate(raw: RawFrame[], fps: number, name: string): MotionTemplate {
  const n = raw.length, faces = raw.map((f, i) => (f.face ? i : -1)).filter(i => i >= 0)
  if (n < 4 || faces.length < Math.max(3, n * 0.2)) throw new Error('No detecto un rostro estable en ese vídeo. Prueba con uno donde se vea la cara de frente y bien iluminada.')
  // Rotación de cada fotograma respecto al primero, y luego respecto a la orientación mediana de la cabeza en todo el clip (neutra): M' = M·Rmedᵀ.
  // Así la foto manda en la pose de partida y la plantilla solo aporta el movimiento, sin depender de cómo estuviera la cabeza en el primer fotograma.
  const ref = normalizePts(raw[faces[0]].face!.pts)
  const Ms = faces.map(i => fitRotation(ref.q, normalizePts(raw[i].face!.pts).q)), ang = Ms.map(toRendererAngles)
  const RmT = T3(composeRenderer(median(ang.map(a => a.ya)), median(ang.map(a => a.pa)), median(ang.map(a => a.r))))
  const yaw = new Array<number | undefined>(n), pitch = new Array<number | undefined>(n), roll = new Array<number | undefined>(n)
  faces.forEach((i, k) => { const { ya, pa, r } = toRendererAngles(mul3(Ms[k], RmT)); yaw[i] = -ya; pitch[i] = -pa; roll[i] = r })   // a la convención "lo que se ve"
  const ex = CH.reduce((o, c) => ((o[c] = new Array<number | undefined>(n)), o), {} as Record<Ch, (number | undefined)[]>)
  const fw = faces.map(i => raw[i].face!.fw), fwMed = median(fw) || 1, cxMed = median(faces.map(i => raw[i].face!.cx)), cyMed = median(faces.map(i => raw[i].face!.cy))
  const hipsRatio = raw.filter(f => f.pose?.hx !== undefined).length / n, poseRatio = raw.filter(f => f.pose).length / n
  const hasBody = poseRatio >= 0.3, useHips = hasBody && hipsRatio >= 0.6
  const shx = median(raw.filter(f => f.pose).map(f => f.pose!.sx)), shy = median(raw.filter(f => f.pose).map(f => f.pose!.sy)), hxm = median(raw.filter(f => f.pose?.hx !== undefined).map(f => f.pose!.hx!))
  for (let i = 0; i < n; i++) {
    const f = raw[i]
    if (f.face) {
      const e = expressionFrom(f.face.bs); for (const k of ['blinkL', 'blinkR', 'lookX', 'lookY', 'smile', 'open', 'browL', 'browR', 'width', 'round'] as const) ex[k][i] = e[k]
      ex.zoom[i] = cl(f.face.fw / fwMed, 0.85, 1.2)
    }
    const p = f.pose
    if (hasBody && p) {
      ex.bob[i] = (p.sy - shy) / fwMed
      if (useHips && p.hx !== undefined) { ex.lean[i] = Math.atan2(p.sx - p.hx, p.hy! - p.sy); ex.sway[i] = (p.hx - hxm) / fwMed }
      else if (!useHips) { ex.lean[i] = p.tilt; ex.sway[i] = (0.6 * (p.sx - shx)) / fwMed }
    } else if (!hasBody && f.face) { ex.sway[i] = (0.6 * (f.face.cx - cxMed)) / fwMed; ex.bob[i] = (f.face.cy - cyMed) / fwMed; ex.lean[i] = 0 }
  }
  // Brazos: ángulos absolutos continuos (sin saltos de ±π) y centrados en (-π, π]; solo si el brazo se ve en al menos el 30 % de los fotogramas
  const armOk = { l: false, r: false }
  for (const side of ['l', 'r'] as const) {
    const sd = side === 'l' ? 'L' : 'R', fr = raw.map(f => f.pose?.arms?.[side]), have = fr.filter(Boolean).length
    if (have < Math.max(3, n * 0.3)) continue
    armOk[side] = true
    for (const [key, name] of [['u', 'u'], ['f', 'f']] as const) {
      const v = fr.map(a => a?.[key]), un = unwrapSeq(v), med = median(un.filter((x): x is number => x !== undefined)), shift = -2 * Math.PI * Math.round(med / (2 * Math.PI))
      ex[(name + sd) as Ch] = un.map(x => (x === undefined ? undefined : x + shift))
    }
    ex[('h' + sd) as Ch] = fr.map(a => (a && a.hd !== undefined ? a.hd : undefined))
  }
  const S: Partial<Record<Ch, number>> = { uL: 1, fL: 1, hL: 1.2, uR: 1, fR: 1, hR: 1.2, yaw: 1, pitch: 1, roll: 1, lean: 1, sway: 1.2, bob: 1.2, zoom: 2, blinkL: 0.4, blinkR: 0.4 }
  const ch = {} as Record<Ch, Float32Array>
  const raws: Record<Ch, (number | undefined)[]> = { ...ex, yaw, pitch, roll }
  for (const c of CH) {
    let a = fillGaps(raws[c]); if (c === 'zoom') { for (let i = 0; i < a.length; i++) if (raws.zoom[i] === undefined) a[i] = 1 }
    a = gauss(a, S[c] ?? 0.8)
    if (['lean', 'sway', 'bob'].includes(c)) sub(a, median(a))   // igual que la cabeza: solo el movimiento, no la posición de partida
    ch[c] = a
  }
  const tpl: MotionTemplate = { v: 1, name, fps, n, dur: n / fps, hasBody, ch, armL: armOk.l, armR: armOk.r }
  closeLoop(tpl)
  const pr = estimatePeriod(tpl); if (pr) { tpl.period = pr.period; tpl.periodConf = pr.conf; tpl.phase = pr.phase }
  return tpl
}
/** Desenvuelve ángulos: cada valor se acerca (±2π·k) al anterior conocido, para que no salte al cruzar ±π. */
export function unwrapSeq(v: (number | undefined)[]): (number | undefined)[] {
  let prev: number | undefined
  return v.map(x => { if (x === undefined) return undefined; const y = prev === undefined ? x : prev + wrapPi(x - prev); prev = y; return y })
}
/** Quita el salto entre el último y el primer fotograma (para el bucle) corrigiendo suavemente los últimos ~0,3 s. No cambia los tiempos. */
function closeLoop(t: MotionTemplate) {
  const k = Math.min(Math.round(0.3 * t.fps), Math.floor(t.n / 4)); if (k < 2) return
  for (const c of CH) { const a = t.ch[c], D = a[0] - a[t.n - 1]; for (let j = 0; j < k; j++) a[t.n - k + j] += D * ss((j + 1) / k) }
}

// ───────────── Periodicidad: cuánto dura un paso y dónde cae el golpe ─────────────
export function estimatePeriod(t: MotionTemplate): { period: number; conf: number; phase: number } | null {
  const typ: Partial<Record<Ch, number>> = { bob: 0.05, sway: 0.05, lean: 0.03, yaw: 0.1, pitch: 0.1, roll: 0.05 }
  const lo = Math.max(2, Math.round(0.3 * t.fps)), hi = Math.min(Math.round(4 * t.fps), Math.floor(t.n / 2))
  if (hi <= lo + 2) return null
  const acc = new Float64Array(hi + 2); let wsum = 0
  for (const c of Object.keys(typ) as Ch[]) {
    const a = t.ch[c], m = a.reduce((s, v) => s + v, 0) / t.n; let v0 = 0; for (let i = 0; i < t.n; i++) v0 += (a[i] - m) ** 2
    const sd = Math.sqrt(v0 / t.n), w = Math.min(1.5, sd / typ[c]!); if (sd < 1e-5 || w < 0.05) continue
    for (let L = 1; L <= hi + 1; L++) { let s = 0; for (let i = 0; i + L < t.n; i++) s += (a[i] - m) * (a[i + L] - m); acc[L] += w * (s / v0) * (t.n / (t.n - L)) }
    wsum += w
  }
  if (wsum <= 0) return null
  const r = (L: number) => acc[L] / wsum; let best = 0; for (let L = lo; L <= hi; L++) best = Math.max(best, r(L))
  if (best < 0.2) return null
  let L0 = lo; for (let L = lo; L <= hi; L++) { if (r(L) >= 0.85 * best && r(L) >= r(L - 1) && r(L) >= r(L + 1)) { L0 = L; break } }   // el ciclo más corto que repite casi tan bien como el mejor
  const y0 = r(L0 - 1), y1 = r(L0), y2 = r(L0 + 1), den = y0 - 2 * y1 + y2, off = den < -1e-9 ? cl(0.5 * (y0 - y2) / den, -0.5, 0.5) : 0, period = (L0 + off) / t.fps
  // Golpe = instante, dentro del primer ciclo, en que el cuerpo está más abajo (bob máximo)
  const b = t.ch.bob, P = Math.max(1, Math.round(period * t.fps)); let bi = 0; for (let i = 1; i < Math.min(P, t.n); i++) if (b[i] > b[bi]) bi = i
  return { period, conf: cl(r(L0)), phase: bi / t.fps }
}

// ───────────── Reproducción sobre una foto ─────────────
/** Geometría de la foto sobre la que se reproduce (en píxeles del lienzo): ancho de cara, tamaño del lienzo y altura de la nariz. */
export interface BodyScale { fw: number; W: number; H: number; headY: number }
export const bodyScaleFor = (L: Pt[], W: number, H: number): BodyScale => ({ fw: Math.hypot(L[454].x - L[234].x, L[454].y - L[234].y), W, H, headY: L[1].y })
export interface TplPlay { tpl: MotionTemplate; gain: number; mirror: boolean; rate: number; start: number; sc: BodyScale; /** brazos de la foto (null = no mover brazos) */ rig?: ArmRig | null }
export type SyncMode = 'video' | 'beat' | 'free'
/** Mismo número de pasos que beats: velocidad con la que el ciclo de la plantilla (period) cae en 1, 2, 4 u 8 beats, la que menos la cambie. */
export function syncRate(period: number, bpm: number): number {
  const b = 60 / bpm; let best = 1, err = Infinity
  for (const nb of [1, 2, 4, 8]) { const r = period / (nb * b), e = Math.abs(Math.log(r)); if (e < err) { err = e; best = r } }
  return cl(best, 0.5, 2)
}
/** video: mismo tiempo que el vídeo original (para usar su audio; startAt = segundo de la música donde empieza el clip) · beat: ajusta el ciclo al BPM y hace coincidir el golpe con el beat · free: tal cual, en bucle. */
export function makePlay(tpl: MotionTemplate, o: { mode: SyncMode; gain: number; mirror: boolean; sc: BodyScale; startAt?: number; spec?: DanceSpec | null; rig?: ArmRig | null }): TplPlay {
  let rate = 1, start = 0
  if (o.mode === 'video') start = o.startAt ?? 0
  else if (o.mode === 'beat' && o.spec && tpl.period && (tpl.periodConf ?? 0) >= 0.2) { rate = syncRate(tpl.period, o.spec.bpm); start = (tpl.phase ?? 0) - o.spec.offset * rate }
  return { tpl, gain: o.gain, mirror: o.mirror, rate, start, sc: o.sc, rig: o.rig ?? null }
}
const sampleLoop = (a: Float32Array, u: number) => { const n = a.length, i = Math.floor(u), f = u - i, i0 = mod(i, n), i1 = (i0 + 1) % n; return a[i0] + (a[i1] - a[i0]) * f }
export function templateAt(t: number, p: TplPlay): { face: FacialMotion; body: BodyMotion } {
  const { tpl, gain: g, mirror, sc } = p, u = mod((t * p.rate + p.start) * tpl.fps, tpl.n), s = (c: Ch) => sampleLoop(tpl.ch[c], u), sg = mirror ? -1 : 1
  const hg = Math.max(0.25, (1 - sc.headY / sc.H) ** 1.2), D = Math.max(1, sc.H - sc.headY)
  const face: FacialMotion = {
    eyeBlinkLeft: s(mirror ? 'blinkR' : 'blinkL'), eyeBlinkRight: s(mirror ? 'blinkL' : 'blinkR'), eyeLookX: sg * s('lookX'), eyeLookY: s('lookY'),
    mouthSmile: s('smile'), mouthOpen: s('open'), eyebrowLeft: s(mirror ? 'browR' : 'browL'), eyebrowRight: s(mirror ? 'browL' : 'browR'),
    headYaw: cl((-sg * s('yaw') * g) / YAW_RAD, -1.6, 1.6), headPitch: cl((-s('pitch') * g) / PITCH_RAD, -1.5, 1.5), headRoll: cl(sg * s('roll') * g, -0.6, 0.6),
    mouthWidth: s('width'), lipRound: s('round')
  }
  const body: BodyMotion = {
    swayX: cl((sg * s('sway') * g * sc.fw) / (0.05 * sc.W * hg), -2.5, 2.5), roll: cl(sg * s('lean') * g, -0.3, 0.3),
    squash: cl(1 - (s('bob') * g * sc.fw) / D, 0.88, 1.05), zoom: cl(1.05 + 0.5 * (s('zoom') - 1), 1.02, 1.12), pulse: 0
  }
  // Brazos y manos: el brazo de la foto de cada lado de la pantalla copia al del vídeo del mismo lado (o al del lado contrario si se refleja)
  if (p.rig) {
    const arms: NonNullable<BodyMotion['arms']> = {}
    for (const side of ['l', 'r'] as const) {
      const j = p.rig[side], from = mirror ? (side === 'l' ? 'R' : 'L') : side === 'l' ? 'L' : 'R'
      if (!j || !(from === 'L' ? tpl.armL : tpl.armR)) continue
      arms[side] = armRot(j, { u: sg * s(('u' + from) as Ch), f: sg * s(('f' + from) as Ch), hd: sg * s(('h' + from) as Ch) }, g)
    }
    if (arms.l || arms.r) body.arms = arms
  }
  return { face, body }
}
/** Fotograma completo: movimiento de la plantilla + (si hay música) graves/medios/agudos y golpe de la coreografía, para que los fondos sigan reaccionando a la canción. */
export function templateFrame(t: number, p: TplPlay, dance?: DanceSpec | null) {
  const f = templateAt(t, p)
  if (dance) { const d = danceAt(t, dance).body; Object.assign(f.body, { pulse: d.pulse, bass: d.bass, mid: d.mid, treble: d.treble }) }
  return f
}

// ───────────── Guardar y cargar ─────────────
export function serializeTemplate(t: MotionTemplate): string {
  const ch: Record<string, number[]> = {}; for (const c of CH) ch[c] = Array.from(t.ch[c], v => Math.round(v * 1e4) / 1e4)
  return JSON.stringify({ format: 'imagemusic-motion', v: t.v, name: t.name, fps: t.fps, n: t.n, hasBody: t.hasBody, armL: !!t.armL, armR: !!t.armR, period: t.period, periodConf: t.periodConf, phase: t.phase, ch })
}
export function parseTemplate(text: string): MotionTemplate {
  let j: any; try { j = JSON.parse(text) } catch { throw new Error('Ese archivo no es una plantilla de movimiento.') }
  if (j?.format !== 'imagemusic-motion' || j.v !== 1 || !(j.fps > 0) || !(j.n >= 4) || !j.ch) throw new Error('Ese archivo no es una plantilla de movimiento compatible.')
  const ch = {} as Record<Ch, Float32Array>
  for (const c of CH) { const a = j.ch[c]; if (ARM_CH.includes(c) && a === undefined) { ch[c] = new Float32Array(j.n); continue }   // plantillas antiguas, sin brazos
    if (!Array.isArray(a) || a.length !== j.n || a.some((x: unknown) => typeof x !== 'number' || !Number.isFinite(x))) throw new Error(`La plantilla está dañada (canal ${c}).`); ch[c] = Float32Array.from(a) }
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined)
  return { v: 1, name: String(j.name ?? 'Plantilla'), fps: j.fps, n: j.n, dur: j.n / j.fps, hasBody: !!j.hasBody, armL: !!j.armL, armR: !!j.armR, ch, period: num(j.period), periodConf: num(j.periodConf), phase: num(j.phase) }
}
