/** Brazos y manos sobre la malla de la foto: tres "huesos" por brazo (brazo, antebrazo, mano) con el hombro, codo, muñeca y punta de la mano medidos en la propia foto.
 *  Módulo puro (sin DOM): lo usan el renderer en CPU, el shader (misma fórmula, ver WARP_FRAG) y la plantilla de movimiento.
 *
 *  Convención de ángulos: radianes medidos desde "recto hacia abajo", + = hacia la DERECHA de la pantalla (atan2(dx, dy) con y hacia abajo).
 *  Lado l / r = lado de la PANTALLA (no del sujeto): l = el brazo que se ve a la izquierda. */
export interface P2 { x: number; y: number }
export interface ArmJoints {
  s: P2; e: P2; w: P2; h: P2
  /** Grosor del brazo (px): radio de influencia de cada hueso. */
  R: number
  /** Ángulos en reposo (los de la foto): brazo, antebrazo y mano RELATIVA al antebrazo. */
  u: number; f: number; hd: number
}
export interface ArmRig { l: ArmJoints | null; r: ArmJoints | null }
/** Giro (rad, en el sentido del renderer: x' = x·cos − y·sin con y hacia abajo) de cada hueso en cascada: brazo sobre el hombro, antebrazo sobre el codo, mano sobre la muñeca. */
export interface ArmRot { a1: number; a2: number; a3: number }
/** Ángulos objetivo absolutos (mismo criterio que los de reposo). hd = mano relativa al antebrazo. */
export interface ArmTarget { u: number; f: number; hd: number }

const TAU = Math.PI * 2
export const wrapPi = (x: number) => x - TAU * Math.round(x / TAU)
export const dirAngle = (a: P2, b: P2) => Math.atan2(b.x - a.x, b.y - a.y)
const cl = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x))
export const MAX_ROT = { a1: 2.0, a2: 2.5, a3: 1.2 }

/** Esqueleto de un brazo a partir de hombro, codo, muñeca y (opcional) nudillos medios de la mano. null si los huesos son degenerados. */
export function makeJoints(s: P2, e: P2, w: P2, knuckle?: P2): ArmJoints | null {
  const lu = Math.hypot(e.x - s.x, e.y - s.y), lf = Math.hypot(w.x - e.x, w.y - e.y)
  if (lu < 8 || lf < 8) return null
  const h = knuckle && Math.hypot(knuckle.x - w.x, knuckle.y - w.y) > 3 ? { x: w.x + 1.8 * (knuckle.x - w.x), y: w.y + 1.8 * (knuckle.y - w.y) } : { x: w.x + 0.35 * (w.x - e.x), y: w.y + 0.35 * (w.y - e.y) }
  const f = dirAngle(e, w)
  return { s, e, w, h, R: cl(0.3 * lu, 6, 160), u: dirAngle(s, e), f, hd: wrapPi(dirAngle(w, h) - f) }
}
/** Giros de los tres huesos para que el brazo de la foto pase de su reposo al objetivo; gain 0 = se queda como la foto, 1 = copia la pose del vídeo. */
export function armRot(j: ArmJoints, t: ArmTarget, gain: number): ArmRot {
  const g = cl(gain, 0, 1.5), du = g * wrapPi(t.u - j.u), ft = j.f + g * wrapPi(t.f - j.f), dh = g * wrapPi(t.hd - j.hd)
  return { a1: cl(-du, -MAX_ROT.a1, MAX_ROT.a1), a2: cl(-(ft - (j.f + du)), -MAX_ROT.a2, MAX_ROT.a2), a3: cl(-dh, -MAX_ROT.a3, MAX_ROT.a3) }
}
export const rotAbout = (p: P2, c: P2, a: number): P2 => { const cs = Math.cos(a), sn = Math.sin(a), dx = p.x - c.x, dy = p.y - c.y; return { x: c.x + dx * cs - dy * sn, y: c.y + dx * sn + dy * cs } }
/** Posición final de las articulaciones tras aplicar los giros (cinemática directa). */
export function pose(j: ArmJoints, r: ArmRot) {
  const e = rotAbout(j.e, j.s, r.a1), w = rotAbout(rotAbout(j.w, j.s, r.a1), e, r.a2), h = rotAbout(rotAbout(rotAbout(j.h, j.s, r.a1), e, r.a2), w, r.a3)
  return { e, w, h }
}
function segd(p: P2, a: P2, b: P2): { d: number; t: number } {
  const abx = b.x - a.x, aby = b.y - a.y, t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / Math.max(abx * abx + aby * aby, 1e-6), c = Math.min(1, Math.max(0, t))
  return { d: Math.hypot(p.x - (a.x + abx * c), p.y - (a.y + aby * c)), t }
}
const sstep = (a: number, b: number, x: number) => { const t = cl((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t) }
/** Desplazamiento del punto (x, y) de la foto por el brazo. DEBE coincidir con el bucle de brazos de WARP_FRAG en WarpRenderer.ts. */
export function armDisp(x: number, y: number, j: ArmJoints, r: ArmRot): [number, number] {
  const p = { x, y }, U = segd(p, j.s, j.e), F = segd(p, j.e, j.w), H = segd(p, j.w, j.h)
  const wu = Math.exp(-((U.d / j.R) ** 4)) * sstep(-0.05, 0.3, U.t), wf = Math.exp(-((F.d / j.R) ** 4)), wh = Math.exp(-((H.d / (j.R * 0.7)) ** 4)), sw = wu + wf + wh
  if (sw <= 1e-4) return [0, 0]
  const e1 = rotAbout(j.e, j.s, r.a1), w1 = rotAbout(rotAbout(j.w, j.s, r.a1), e1, r.a2)
  const pu = rotAbout(p, j.s, r.a1), pf = rotAbout(pu, e1, r.a2), ph = rotAbout(pf, w1, r.a3), inf = Math.max(wu, wf, wh)
  return [inf * ((pu.x * wu + pf.x * wf + ph.x * wh) / sw - x), inf * ((pu.y * wu + pf.y * wf + ph.y * wh) / sw - y)]
}
/** Uniform uA[6] del shader: por brazo (S, E) · (W, H) · (a1, a2, a3, R); R = 0 desactiva ese brazo. */
export function armUniforms(rig: ArmRig | null | undefined, rots: { l?: ArmRot; r?: ArmRot } | undefined, out: Float32Array) {
  out.fill(0)
  ;(['l', 'r'] as const).forEach((k, i) => {
    const j = rig?.[k], q = rots?.[k]; if (!j || !q) return
    out.set([j.s.x, j.s.y, j.e.x, j.e.y, j.w.x, j.w.y, j.h.x, j.h.y, q.a1, q.a2, q.a3, j.R], 12 * i)
  })
}
