/** Reactividad al espectro (módulo puro, sin DOM): de graves/medios/agudos por fotograma saca
 *  · kick / hat: envolventes de los golpes de graves y de agudos (1 en el golpe, caen rápido),
 *  · hits: instantes de golpes de percusión fuertes (el montaje puede cortar en ellos aunque no caigan en un beat),
 *  · hue: un tono (0..360) que sigue el equilibrio graves ↔ agudos de la canción, suavizado. */
export interface Hit { t: number; k: number }
export interface Reactive { kick: Float32Array; hat: Float32Array; hue: Float32Array; hits: Hit[]; fps: number }
/** Subida brusca respecto a la media de los 4 fotogramas anteriores. */
function flux(x: Float32Array): Float32Array {
  const o = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) { let m = 0, c = 0; for (let j = 1; j <= 4 && i - j >= 0; j++) { m += x[i - j]; c++ } o[i] = Math.max(0, x[i] - (c ? m / c : x[i])) }
  return o
}
const norm = (a: Float32Array) => { const p = [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)] || 0, d = Math.max(p, 0.02); return a.map(v => Math.min(1, v / d)) }
const envelope = (f: Float32Array, decay: number) => { const e = new Float32Array(f.length); for (let i = 0; i < f.length; i++) e[i] = Math.max(f[i], i ? e[i - 1] * decay : 0); return e }
export function reactiveFrom(bands: ArrayLike<number>, fps: number): Reactive | null {
  const n = Math.floor(bands.length / 3); if (n < 6) return null
  const b = new Float32Array(n), m = new Float32Array(n), h = new Float32Array(n); for (let i = 0; i < n; i++) { b[i] = bands[3 * i]; m[i] = bands[3 * i + 1]; h[i] = bands[3 * i + 2] }
  const fb = norm(flux(b)), fh = norm(flux(h)), dec = Math.pow(0.38, 1 / Math.max(1, 0.2 * fps)), hits: Hit[] = [], s = (i: number) => Math.max(fb[i], 0.8 * fh[i])
  for (let i = 1; i < n - 1; i++) if (s(i) > 0.55 && s(i) >= s(i - 1) && s(i) >= s(i + 1) && (!hits.length || i / fps - hits[hits.length - 1].t >= 0.12)) hits.push({ t: i / fps, k: s(i) })
  // Tono: equilibrio agudos/graves en ventana de ~1,5 s
  const w = Math.max(1, Math.round(1.5 * fps)), bal = new Float32Array(n), cs = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) { bal[i] = (h[i] + 0.5 * m[i]) / (b[i] + m[i] + h[i] + 1e-3); cs[i + 1] = cs[i] + bal[i] }
  const hue = new Float32Array(n); for (let i = 0; i < n; i++) { const a = Math.max(0, i - w), z = Math.min(n, i + w + 1), v = (cs[z] - cs[a]) / (z - a); hue[i] = 200 + 150 * Math.min(1, Math.max(0, v * 1.8)) }
  return { kick: envelope(fb, dec), hat: envelope(fh, dec), hue, hits, fps }
}
