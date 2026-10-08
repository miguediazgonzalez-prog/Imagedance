/** Varias personas en una foto (módulo puro, sin DOM: se prueba en Node).
 *  Cada persona se anima con su propio pase del deformador; después se mezclan con un reparto suave de la imagen (Voronoi blando alrededor de cada cuerpo). */
export interface Face { cx: number; cy: number; fw: number }
interface P2 { x: number; y: number }
/** Centro y ancho del rostro (píxeles) a partir de los 478 landmarks de MediaPipe. */
export function faceOf(L: P2[]): Face {
  return { cx: (L[234].x + L[454].x) / 2, cy: (L[10].y + L[152].y) / 2, fw: Math.max(1, Math.hypot(L[454].x - L[234].x, L[454].y - L[234].y)) }
}
/** Zona que ocupa el cuerpo de una persona (hombros incluidos) en píxeles. */
export function bodyBox(f: Face, W: number, H: number) {
  const x0 = Math.max(0, f.cx - 1.6 * f.fw), x1 = Math.min(W, f.cx + 1.6 * f.fw), y0 = Math.max(0, f.cy - 1.0 * f.fw), y1 = Math.min(H, f.cy + 3.0 * f.fw)
  return { x0, y0, x1, y1 }
}
/** Distancia (en anchos de rostro) de un punto al «eje» de la persona: del centro del rostro hacia abajo (el torso). */
function dist(f: Face, x: number, y: number): number {
  const dx = x - f.cx, bot = f.cy + 3 * f.fw, dy = y < f.cy ? y - f.cy : y > bot ? y - bot : 0
  return Math.hypot(dx, dy * 0.8) / f.fw
}
/** Cuadrícula de reparto con la proporción de la foto (lado largo = max). */
export const gridFor = (W: number, H: number, max = 96) => (W >= H ? { gw: max, gh: Math.max(2, Math.round((max * H) / W)) } : { gw: Math.max(2, Math.round((max * W) / H)), gh: max })
/** Pesos de cada persona en cada celda (suman 1). Una persona siempre domina junto a su cara; entre dos hay una transición suave. */
export function weights(faces: Face[], W: number, H: number, gw: number, gh: number, beta = 2.5): Float32Array[] {
  const out = faces.map(() => new Float32Array(gw * gh)), d = new Float64Array(faces.length)
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const x = ((gx + 0.5) / gw) * W, y = ((gy + 0.5) / gh) * H; let m = Infinity
    for (let i = 0; i < faces.length; i++) { d[i] = dist(faces[i], x, y); if (d[i] < m) m = d[i] }
    let s = 0; for (let i = 0; i < faces.length; i++) { d[i] = Math.exp(-beta * (d[i] * d[i] - m * m)); s += d[i] }
    for (let i = 0; i < faces.length; i++) out[i][gy * gw + gx] = d[i] / s
  }
  return out
}
/** Alfas para mezclar por capas con «source-over»: la capa 0 va entera y la capa k entra con alfa w_k / (w_0+…+w_k). El resultado es exactamente Σ w_i·frame_i. Devuelve las capas 1..n-1 (0..255). */
export function layerAlphas(faces: Face[], W: number, H: number, gw: number, gh: number): Uint8ClampedArray[] {
  const w = weights(faces, W, H, gw, gh), res: Uint8ClampedArray[] = [], acc = new Float32Array(gw * gh)
  for (let k = 0; k < faces.length; k++) {
    for (let i = 0; i < acc.length; i++) acc[i] += w[k][i]
    if (k === 0) continue
    const a = new Uint8ClampedArray(gw * gh); for (let i = 0; i < a.length; i++) a[i] = Math.round((w[k][i] / acc[i]) * 255); res.push(a)
  }
  return res
}
