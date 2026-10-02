/** Ritmo: BPM (autocorrelación del onset + ajuste fino por peine), fase de los beats en un fragmento y energía por fotograma. Sin DOM: se puede probar en Node. */
/** env = golpes de todo el espectro (para el BPM); pe = lo mismo pero con los graves (bombo) mandando, para saber en qué instante cae el beat. */
export interface Tempo { bpm: number; conf: number; env: Float32Array; pe: Float32Array; rate: number }
const RATE = 200, MIN_BPM = 55, MAX_BPM = 200, MAX_SECS = 480

/** Gaussiana suave (σ en muestras) con bordes reflejados. */
function blur(a: Float32Array, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 3), k = new Float32Array(2 * r + 1); let s = 0
  for (let i = -r; i <= r; i++) s += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma))
  const o = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++) { let v = 0; for (let j = -r; j <= r; j++) { const x = i + j; v += a[x < 0 ? 0 : x >= a.length ? a.length - 1 : x] * k[j + r] } o[i] = v / s }
  return o
}
/** Valor interpolado de un array en una posición fraccionaria. */
const at = (a: Float32Array, p: number) => { const i = Math.floor(p); if (i < 0 || i >= a.length - 1) return 0; const f = p - i; return a[i] * (1 - f) + a[i + 1] * f }

/** Curva de "golpes" (onsets): flujo positivo del log-energía en graves y en agudos, ~200 valores/s. */
function onsetEnvelope(mono: Float32Array, sr: number): { env: Float32Array; pe: Float32Array; rate: number } {
  const hop = Math.max(1, Math.round(sr / RATE)), rate = sr / hop, n = Math.floor(Math.min(mono.length, MAX_SECS * sr) / hop)
  const aLo = 1 - Math.exp((-2 * Math.PI * 150) / sr), aHi = 1 - Math.exp((-2 * Math.PI * 2000) / sr)
  const bands = [new Float32Array(n), new Float32Array(n)]; let lo = 0, hi = 0
  for (let f = 0; f < n; f++) {
    let eLo = 0, eHi = 0
    for (let i = f * hop; i < (f + 1) * hop; i++) { const x = mono[i]; lo += aLo * (x - lo); hi += aHi * (x - hi); const h = x - hi; eLo += lo * lo; eHi += h * h }
    bands[0][f] = Math.log(1 + 300 * Math.sqrt(eLo / hop)); bands[1][f] = Math.log(1 + 300 * Math.sqrt(eHi / hop))
  }
  const env = new Float32Array(n), pe0 = new Float32Array(n)
  bands.forEach((b, bi) => {
    const s = blur(b, 1.5), d = new Float32Array(n); let m = 0
    for (let f = 1; f < n; f++) { d[f] = Math.max(0, s[f] - s[f - 1]); m += d[f] }
    m = m / Math.max(1, n) || 1e-9
    for (let f = 0; f < n; f++) { env[f] += (d[f] / m) * (bi ? 0.7 : 1); pe0[f] += (d[f] / m) * (bi ? 0.3 : 1) }
  })
  // Quita la media local (~0.4 s) para quedarse solo con los picos.
  const loc = blur(env, rate * 0.2), out = new Float32Array(n), loc2 = blur(pe0, rate * 0.2), pe = new Float32Array(n)
  for (let f = 0; f < n; f++) { out[f] = Math.max(0, env[f] - loc[f]); pe[f] = Math.max(0, pe0[f] - loc2[f]) }
  return { env: out, pe, rate }
}

/** Puntuación de peine: media de la curva en los instantes fase + k·periodo, con la mejor fase. Devuelve [puntuación, fase en muestras]. */
function comb(env: Float32Array, period: number, from: number, to: number): [number, number] {
  let best = -1, bp = 0
  for (let ph = 0; ph < period; ph += 0.5) {
    let s = 0, c = 0
    for (let p = from + ph; p < to - 1; p += period) { s += at(env, p); c++ }
    if (c && s / c > best) { best = s / c; bp = ph }
  }
  return [best, bp]
}

export function analyzeTempo(mono: Float32Array, sr: number): Tempo {
  const { env, pe, rate } = onsetEnvelope(mono, sr), n = env.length
  if (n < rate * 4) return { bpm: 120, conf: 0, env, pe, rate }
  const mean = env.reduce((a, b) => a + b, 0) / n, z = env.map(v => v - mean)
  const maxLag = Math.ceil((rate * 60) / MIN_BPM) * 4, acf = new Float32Array(maxLag + 1)
  for (let l = 0; l <= maxLag; l++) { let s = 0; for (let i = 0; i + l < n; i++) s += z[i] * z[i + l]; acf[l] = s / (n - l) }
  // Candidatos con a priori hacia ~120 BPM; suma armónicos (2L, 4L) para preferir el pulso con estructura de compás.
  let bestB = 120, bestS = -Infinity
  for (let b = MIN_BPM; b <= MAX_BPM; b += 0.25) {
    const L = (rate * 60) / b, prior = Math.exp(-0.5 * (Math.log2(b / 120) / 0.9) ** 2)
    const s = prior * (at(acf, L) + 0.5 * at(acf, 2 * L) + 0.25 * at(acf, 4 * L))
    if (s > bestS) { bestS = s; bestB = b }
  }
  // Ajuste fino: peine sobre la curva suavizada en ±3 % alrededor del candidato.
  const es = blur(env, 2); let fb = bestB, fs = -1
  for (let b = bestB * 0.97; b <= bestB * 1.03; b += 0.05) { const s = comb(es, (rate * 60) / b, 0, n)[0]; if (s > fs) { fs = s; fb = b } }
  const r = Math.round(fb), bpm = Math.abs(fb - r) < 0.25 ? r : Math.round(fb * 10) / 10
  // Confianza: fuerza del pico de autocorrelación respecto a la varianza total (0 = sin pulso, ~0.3+ = ritmo marcado).
  return { bpm, conf: Math.max(0, at(acf, (rate * 60) / bpm) / (acf[0] || 1)), env, pe, rate }
}

/** Instante (s, relativo al inicio del fragmento) del primer beat dentro de [t0, t1] del audio, para el BPM dado. */
export function beatOffset(t: Tempo, bpm: number, t0: number, t1: number): number {
  const es = blur(t.pe, 2), period = (t.rate * 60) / bpm
  const from = Math.max(0, Math.round(t0 * t.rate)), to = Math.min(es.length, Math.round(t1 * t.rate))
  if (to - from < period * 2) return 0
  return comb(es, period, from, to)[1] / t.rate
}

/** Energía 0..1 por fotograma (RMS suavizado ~1 s, normalizado por el percentil 95). */
export function energyFrames(mono: Float32Array, sr: number, fps: number, t0: number, n: number): number[] {
  const hop = sr / fps, rms = new Float32Array(n)
  for (let f = 0; f < n; f++) {
    const s = Math.floor((t0 * fps + f) * hop), e = Math.min(mono.length, Math.floor((t0 * fps + f + 1) * hop)); let a = 0
    for (let i = s; i < e; i++) a += mono[i] * mono[i]
    rms[f] = e > s ? Math.sqrt(a / (e - s)) : 0
  }
  const sm = blur(rms, fps * 0.4), p95 = Math.max(1e-6, [...sm].sort((a, b) => a - b)[Math.floor(n * 0.95)] || 0)
  return Array.from(sm, v => Math.min(1, v / p95))
}
