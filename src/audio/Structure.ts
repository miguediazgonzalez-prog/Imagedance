/** Estructura musical: espectro por bandas, primer tiempo de cada compás (4/4), cambios de sección (estrofa/estribillo/drop) y mejor momento. Sin DOM: se puede probar en Node.
 *  Dos pasos: analyzeSpectral (pesado, una vez por canción) y analyzeBars (barato, se repite al cambiar BPM o mover el 1). */
export interface Spectral { hop: number; n: number; dur: number; cum: Float64Array[] }   // cum[k][i] = suma acumulada de la energía (log) de la banda k hasta el fotograma i
export interface Cut { t: number; drop: boolean; score: number }
export interface Bars { g0: number; per: number; jD: number; conf: number; known: boolean; starts: number[]; loud: number[]; cuts: Cut[]; dbg?: { nov: number[]; bassUp: number[]; allUp: number[] } }
const THR_SD = 0.45   // umbral de novedad = media + 0,45·σ (calibrado con una canción de estructura conocida: da exactamente sus 4 cambios, sin falsos)
const K = 24, F_LO = 40, F_HI = 5000, WIN = 1024, HOP = 512, TARGET_SR = 11025
const centre = (k: number) => F_LO * (F_HI / F_LO) ** ((k + 0.5) / K)
const BASS = Array.from({ length: K }, (_, k) => k).filter(k => centre(k) < 150)
const MID = Array.from({ length: K }, (_, k) => k).filter(k => centre(k) >= 150 && centre(k) < 2000)
const mod = (x: number, d: number) => ((x % d) + d) % d

function makeFft(N: number) {
  const lv = Math.round(Math.log2(N)), rev = new Uint16Array(N), cs = new Float32Array(N / 2), sn = new Float32Array(N / 2)
  for (let i = 0; i < N; i++) rev[i] = (rev[i >> 1] >> 1) | ((i & 1) << (lv - 1))
  for (let i = 0; i < N / 2; i++) { cs[i] = Math.cos((2 * Math.PI * i) / N); sn[i] = Math.sin((2 * Math.PI * i) / N) }
  return (re: Float32Array, im: Float32Array) => {
    for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t } }
    for (let size = 2; size <= N; size *= 2) {
      const half = size / 2, step = N / size
      for (let i = 0; i < N; i += size) for (let j = 0, k = 0; j < half; j++, k += step) {
        const a = i + j, b = a + half, tr = re[b] * cs[k] + im[b] * sn[k], ti = im[b] * cs[k] - re[b] * sn[k]
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti
      }
    }
  }
}

/** Espectro en K bandas log-espaciadas (40 Hz – 5 kHz) por fotograma de ~46 ms. Se submuestrea a ~11 kHz antes de la FFT. Cede el hilo cada pocos cientos de fotogramas. */
export async function analyzeSpectral(mono: Float32Array, sr: number, maxSecs = 480): Promise<Spectral> {
  const d = Math.max(1, Math.round(sr / TARGET_SR)), sr2 = sr / d, m = Math.floor(Math.min(mono.length, maxSecs * sr) / d)
  const dec = new Float32Array(m)
  for (let i = 0; i < m; i++) { let a = 0; for (let j = 0; j < d; j++) a += mono[i * d + j]; dec[i] = a / d }
  const n = Math.max(0, Math.floor((m - WIN) / HOP) + 1), hop = HOP / sr2, fft = makeFft(WIN)
  const hann = new Float32Array(WIN); for (let i = 0; i < WIN; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WIN - 1))
  // Bines de cada banda; en graves una banda puede quedarse sin ningún bin: entonces usa el más cercano a su centro.
  const bins: number[][] = Array.from({ length: K }, () => [])
  for (let i = 1; i < WIN / 2; i++) { const f = (i * sr2) / WIN; if (f >= F_LO && f < F_HI) bins[Math.floor((Math.log(f / F_LO) / Math.log(F_HI / F_LO)) * K)].push(i) }
  bins.forEach((b, k) => { if (!b.length) b.push(Math.max(1, Math.round((centre(k) * WIN) / sr2))) })
  const cum = Array.from({ length: K }, () => new Float64Array(n + 1)), re = new Float32Array(WIN), im = new Float32Array(WIN)
  for (let f = 0; f < n; f++) {
    const o = f * HOP
    for (let i = 0; i < WIN; i++) { re[i] = dec[o + i] * hann[i]; im[i] = 0 }
    fft(re, im)
    for (let k = 0; k < K; k++) {
      let s = 0; for (const i of bins[k]) s += re[i] * re[i] + im[i] * im[i]
      cum[k][f + 1] = cum[k][f] + Math.log(1 + (100 * Math.sqrt(s / bins[k].length)) / (WIN / 4))
    }
    if (f % 300 === 299) await new Promise(r => setTimeout(r))
  }
  return { hop, n, dur: n * hop, cum }
}

/** Media de la banda k entre los instantes t0 y t1 (s). */
const avg = (S: Spectral, k: number, t0: number, t1: number) => {
  const i0 = Math.min(S.n - 1, Math.max(0, Math.round(t0 / S.hop))), i1 = Math.min(S.n, Math.max(i0 + 1, Math.round(t1 / S.hop)))
  return (S.cum[k][i1] - S.cum[k][i0]) / (i1 - i0)
}
const zs = (a: number[]) => { const m = a.reduce((x, y) => x + y, 0) / Math.max(1, a.length), sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length)) || 1e-6; return a.map(v => (v - m) / sd) }

/** Qué tiempo (0..3, contando desde el beat 0 de la rejilla) es el primer tiempo del compás. Dos pistas:
 *  1) Contratiempo: en la mayoría de estilos caja/palmas suenan en el 2 y el 4, así que los tiempos con menos ataque agudo son 1 y 3.
 *  2) Entre esos dos (o entre los cuatro si no hay contratiempo claro) gana el que más cambia el dibujo de graves respecto al tiempo anterior (nota de bajo / acorde nuevo).
 *  Es una estimación: conf 0..1 baja cuando las pistas no son claras (el usuario puede mover el 1 a mano). */
export function barPhase(S: Spectral, bpm: number, g0: number): { jD: number; conf: number } {
  const P = 60 / bpm, LOW = Array.from({ length: K }, (_, k) => k).filter(k => centre(k) < 500), HI = Array.from({ length: K }, (_, k) => k).filter(k => centre(k) >= 1500)
  const shape = (t: number) => { const v = LOW.map(k => avg(S, k, t + 0.1 * P, t + 0.45 * P)), m = v.reduce((a, x) => a + x, 0) / v.length; return v.map(x => x - m) }
  const hiOn: number[][] = [[], [], [], []], chg: number[][] = [[], [], [], []]; let prev: number[] | null = null, n = 0
  for (let j = 1; g0 + j * P + 0.45 * P < S.dur; j++) {
    const t = g0 + j * P, cur = t - 0.45 * P >= 0 ? shape(t) : null
    if (cur && prev) {
      let o = 0; for (const k of HI) o += Math.max(0, avg(S, k, t - 0.05 * P, t + 0.3 * P) - avg(S, k, t - 0.45 * P, t - 0.05 * P))
      hiOn[j % 4].push(o / HI.length); chg[j % 4].push(cur.reduce((a, x, i) => a + Math.abs(x - prev![i]), 0)); n++
    }
    prev = cur
  }
  if (n < 8) return { jD: 0, conf: 0 }
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0), h = hiOn.map(mean), c = chg.map(mean)
  const he = h[0] + h[2], ho = h[1] + h[3], strength = Math.abs(ho - he) / (ho + he + 1e-9), parity = strength > 0.25 ? (he < ho ? 0 : 1) : -1
  const cand = [0, 1, 2, 3].filter(i => parity < 0 || i % 2 === parity).sort((a, b) => c[b] - c[a]), cm = mean(c) || 1e-9
  const margin = (c[cand[0]] - c[cand[1]]) / cm
  return { jD: cand[0], conf: Math.min(1, (parity >= 0 ? 0.4 : 0) + 0.6 * Math.min(1, Math.max(0, margin / 0.25))) }
}

/** Compases, secciones y drops para un BPM y una rejilla (g0 = instante de un beat; known = el primer tiempo en g0 es seguro, p. ej. canciones incluidas). */
export function analyzeBars(S: Spectral, bpm: number, g0: number, known: boolean, shift = 0): Bars {
  const P = 60 / bpm, per = 4 * P, ph = known ? { jD: 0, conf: 1 } : barPhase(S, bpm, g0), jD = (ph.jD + shift) % 4
  const starts: number[] = []; for (let j = jD; g0 + (j + 4) * P <= S.dur; j += 4) if (g0 + j * P >= 0) starts.push(g0 + j * P)
  const out: Bars = { g0, per, jD, conf: ph.conf, known, starts, loud: [], cuts: [] }, nb = starts.length
  if (nb < 4) return out
  const F: number[][] = Array.from({ length: K }, (_, k) => zs(starts.map(t => avg(S, k, t, t + per))))   // F[k][bar], cada banda en unidades z
  out.loud = zs(starts.map((_, i) => F.reduce((a, f) => a + f[i], 0) / K))
  const w = Math.min(4, Math.floor(nb / 3)); if (w < 2) return out
  const mean = (k: number, a: number, b: number) => { let s = 0; for (let i = a; i < b; i++) s += F[k][i]; return s / (b - a) }
  const nov: number[] = new Array(nb).fill(0), bassUp: number[] = new Array(nb).fill(0), allUp: number[] = new Array(nb).fill(0), jump: number[] = new Array(nb).fill(0)
  for (let i = w; i <= nb - w; i++) {
    let q = 0, bu = 0, au = 0
    for (let k = 0; k < K; k++) { const dlt = mean(k, i, i + w) - mean(k, i - w, i); q += dlt * dlt; au += dlt; if (BASS.includes(k)) bu += dlt }
    nov[i] = Math.sqrt(q / K); bassUp[i] = bu / BASS.length; allUp[i] = au / K
    jump[i] = out.loud[i] - (out.loud[i - 1] + out.loud[i - 2]) / 2   // salto de volumen en el propio compás (el golpe del drop)
  }
  out.dbg = { nov, bassUp, allUp }
  const v = nov.slice(w, nb - w + 1), mu = v.reduce((a, b) => a + b, 0) / v.length, sd = Math.sqrt(v.reduce((a, b) => a + (b - mu) ** 2, 0) / v.length)
  const thr = Math.max(0.6, mu + THR_SD * sd), got: number[] = []
  const peaks = v.map((_, x) => x + w).filter(i => nov[i] >= thr && [-2, -1, 1, 2].every(d => nov[i + d] === undefined || nov[i] >= nov[i + d])).sort((a, b) => nov[b] - nov[a])
  for (const i of peaks) if (got.every(g => Math.abs(g - i) >= 8)) got.push(i)   // como mínimo 8 compases entre secciones
  out.cuts = got.sort((a, b) => a - b).map(i => ({ t: starts[i], drop: bassUp[i] > 0.8 && (allUp[i] > 0.4 || jump[i] > 0.8), score: nov[i] }))
  return out
}

/** Mejor segundo de inicio para un clip de `dur` s: arranca en un cambio de sección (mejor si es un drop) y cae en la parte más intensa. */
export function bestStart(b: Bars, dur: number): number {
  if (b.starts.length < 2) return 0
  const cand = [{ t: b.starts[0], bonus: -0.4 }, ...b.cuts.map(c => ({ t: c.t, bonus: c.drop ? 0.8 : 0.2 }))]
  let best = 0, bs = -Infinity
  for (const c of cand) {
    const i0 = b.starts.findIndex(t => t >= c.t - 1e-6), n = Math.max(1, Math.round(dur / b.per)), seg = b.loud.slice(i0, i0 + n)
    if (!seg.length) continue
    const s = seg.reduce((a, x) => a + x, 0) / seg.length + c.bonus - (seg.length < n ? 0.5 : 0)
    if (s > bs) { bs = s; best = c.t }
  }
  return best
}

// ── Espectro por fotograma de vídeo: graves / medios / agudos (0..1) para que los fondos reaccionen a la canción, no solo al golpe ──
const TREB = Array.from({ length: K }, (_, k) => k).filter(k => centre(k) >= 2000)
const groupSeries = (S: Spectral, ks: number[]) => { const o = new Float32Array(S.n); for (let i = 0; i < S.n; i++) { let a = 0; for (const k of ks) a += S.cum[k][i + 1] - S.cum[k][i]; o[i] = a / ks.length } return o }
const normCache = new WeakMap<Spectral, { ser: Float32Array[]; lo: number[]; hi: number[] }>()
function bandNorm(S: Spectral) {
  let c = normCache.get(S); if (c) return c
  const ser = [BASS, MID, TREB].map(ks => groupSeries(S, ks)), lo: number[] = [], hi: number[] = []
  for (const s of ser) { const srt = Float32Array.from(s).sort(), at = (q: number) => srt[Math.min(srt.length - 1, Math.floor(q * srt.length))] ?? 0; lo.push(at(0.1)); hi.push(Math.max(at(0.95), at(0.1) + 1e-3)) }
  normCache.set(S, c = { ser, lo, hi }); return c
}
/** 3 valores por fotograma (graves, medios, agudos), normalizados con los percentiles 10–95 de toda la canción (así un tema flojo o fuerte usa todo el rango).
 *  Ataque instantáneo y caída suave (~0,18 s) para que se vea el golpe y no un parpadeo. */
export function bandFrames(S: Spectral, fps: number, t0: number, frames: number): Float32Array {
  const out = new Float32Array(frames * 3); if (S.n < 2) return out
  const { ser, lo, hi } = bandNorm(S), decay = Math.exp(-1 / (fps * 0.18)), env = [0, 0, 0]
  for (let f = 0; f < frames; f++) {
    const i = Math.min(S.n - 1, Math.max(0, Math.round((t0 + f / fps) / S.hop)))
    for (let b = 0; b < 3; b++) { const v = Math.min(1, Math.max(0, (ser[b][i] - lo[b]) / (hi[b] - lo[b]))); env[b] = Math.max(v, env[b] * decay); out[f * 3 + b] = env[b] }
  }
  return out
}
