/** Pruebas de Reactive (módulo puro): npm test */
import { reactiveFrom } from '../src/audio/Reactive'
let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.error('✗', m) } else console.log('✓', m) }
const fps = 30, n = fps * 10, bands = new Float32Array(n * 3)
// Bombo a 2 Hz (graves), hi-hat a 4 Hz fuera de fase (agudos), medios planos
for (let i = 0; i < n; i++) { const t = i / fps, kp = (t * 2) % 1, hp = (t * 4 + 0.5) % 1; bands[3 * i] = 0.1 + 0.9 * Math.exp(-8 * kp); bands[3 * i + 1] = 0.3; bands[3 * i + 2] = 0.1 + 0.8 * Math.exp(-10 * hp) }
const r = reactiveFrom(bands, fps)!
ok(!!r && r.kick.length === n && r.hue.length === n, 'tamaños correctos')
const kicks = r.hits.filter(h => Math.abs(((h.t * 2) % 1)) < 0.12 || Math.abs(((h.t * 2) % 1) - 1) < 0.12)
ok(r.hits.length >= 15 && r.hits.length <= 45, `golpes detectados (${r.hits.length}) en 10 s con 20 bombos y 40 hi-hats`)
ok(kicks.length >= 15, `los bombos se detectan (${kicks.length})`)
ok(r.hits.every((h, i) => i === 0 || h.t - r.hits[i - 1].t >= 0.11), 'separación mínima entre golpes')
const at = Math.round(1 * fps) // un bombo cae en t = 1 s
ok(r.kick[at + 1] > 0.5, 'envolvente alta justo en el bombo'); ok(r.kick[at + 12] < r.kick[at + 1], 'la envolvente cae')
ok(r.hue.every(v => v >= 0 && v < 360 && Number.isFinite(v)), 'tono válido')
// Más agudos → tono más alto
const hi = new Float32Array(n * 3).map((_, i) => (i % 3 === 2 ? 0.9 : 0.05)), lo = new Float32Array(n * 3).map((_, i) => (i % 3 === 0 ? 0.9 : 0.05))
ok(reactiveFrom(hi, fps)!.hue[100] > reactiveFrom(lo, fps)!.hue[100], 'más agudos → otro tono que con graves')
ok(reactiveFrom(new Float32Array(6), fps) === null, 'sin datos suficientes → null')
const silent = reactiveFrom(new Float32Array(n * 3), fps)!; ok(silent.hits.length === 0 && Math.max(...silent.kick) === 0, 'silencio: sin golpes')
console.log(fails ? `\n${fails} fallo(s)` : '\nTodo correcto'); process.exit(fails ? 1 : 0)
