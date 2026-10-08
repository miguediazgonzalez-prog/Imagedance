/** Pruebas del guion del montaje y del reparto entre personas (módulos puros): npm test */
import { layerAlphas, weights, gridFor, type Face } from '../src/ai/People'
import { planMontage, restCam, cameraAt, shotAt, coverScale, clampCam, type PhotoInfo, type Style } from '../src/rendering/Montage'
let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.error('✗', m) } else console.log('✓', m) }
const near = (a: number, b: number, tol: number, m: string) => ok(Math.abs(a - b) <= tol, `${m} (${a.toFixed(4)} ≈ ${b.toFixed(4)})`)

// 1) Reparto: los pesos suman 1 y cada persona domina junto a su cara
const W = 1200, H = 800, faces: Face[] = [{ cx: 300, cy: 250, fw: 120 }, { cx: 700, cy: 260, fw: 130 }, { cx: 1000, cy: 240, fw: 110 }]
const { gw, gh } = gridFor(W, H), w = weights(faces, W, H, gw, gh)
let maxErr = 0; for (let i = 0; i < gw * gh; i++) maxErr = Math.max(maxErr, Math.abs(w[0][i] + w[1][i] + w[2][i] - 1)); ok(maxErr < 1e-5, 'los pesos suman 1')
const cell = (x: number, y: number) => Math.floor((y / H) * gh) * gw + Math.floor((x / W) * gw)
ok(w[0][cell(300, 250)] > 0.97 && w[1][cell(700, 260)] > 0.97 && w[2][cell(1000, 240)] > 0.97, 'cada persona domina en su cara')
ok(w[1][cell(500, 250)] > 0.05 && w[0][cell(500, 250)] > 0.05, 'transición suave entre dos personas')
// Mezcla por capas con source-over == suma ponderada
const al = layerAlphas(faces, W, H, gw, gh), f = [0.2, 0.5, 0.9]; let worst = 0
for (let i = 0; i < gw * gh; i += 7) { let c = f[0]; for (let k = 1; k < 3; k++) { const a = al[k - 1][i] / 255; c = c * (1 - a) + f[k] * a } worst = Math.max(worst, Math.abs(c - (w[0][i] * f[0] + w[1][i] * f[1] + w[2][i] * f[2]))) }
ok(worst < 0.01, `mezcla por capas = suma ponderada (error ${worst.toFixed(4)})`)

// 2) Guion
const photos: PhotoInfo[] = [
  { W: 1200, H: 800, faces },
  { W: 800, H: 1100, faces: [{ cx: 400, cy: 380, fw: 260 }] },
  { W: 1000, H: 1000, faces: [{ cx: 300, cy: 400, fw: 200 }, { cx: 700, cy: 420, fw: 210 }] },
  { W: 900, H: 600, faces: [] }
]
const energy = Array.from({ length: 60 * 30 }, (_, i) => (i < 300 ? 0.2 : i < 900 ? 0.55 : 0.95))
for (const style of ['soft', 'dynamic', 'extreme'] as Style[]) for (const bpm of [100, 128, 174]) {
  const per = 60 / bpm, offset = 0.13, dur = 60
  const plan = planMontage({ photos, dur, bpm, offset, bar0: 1, cuts: [{ t: 10, drop: false }, { t: 30.1, drop: true }], energy, fps: 30, style }), S = plan.shots
  const tag = `${style}/${bpm}`
  ok(S[0].t0 === 0 && Math.abs(S[S.length - 1].t1 - dur) < 1e-9, `${tag}: cubre todo el vídeo`)
  ok(S.every((s, i) => s.t1 > s.t0 && (i === 0 || Math.abs(s.t0 - S[i - 1].t1) < 1e-9)), `${tag}: planos contiguos y no vacíos`)
  const inner = S.slice(1, -1).filter(s => s.t0 > 0).every(s => { const j = (s.t0 - offset) / per; return Math.abs(j - Math.round(j)) < 1e-6 || Math.abs(s.t1 - dur) < 1e-9 }); ok(inner, `${tag}: cada corte cae en un beat`)
  ok(S.every(s => s.photo >= 0 && s.photo < photos.length), `${tag}: fotos válidas`)
  ok(new Set(S.map(s => s.photo)).size === photos.length, `${tag}: aparecen todas las fotos`)
  ok(S.every((s, i) => i === 0 || photos.length < 2 || s.photo !== S[i - 1].photo || s.finale), `${tag}: nunca el mismo plano seguido de la misma foto`)
  ok(S[S.length - 1].kind === 'wide' && S[S.length - 1].finale, `${tag}: final con plano general`)
  ok(S.every(s => s.tr >= 0 && s.tr <= 0.4 * (s.t1 - s.t0) + 1e-9), `${tag}: transiciones más cortas que el plano`)
  const cutT = [10, 30.1].map(c => offset + Math.round((c - offset) / per) * per); ok(cutT.every(c => S.some(s => Math.abs(s.t0 - c) < 1e-6)), `${tag}: corta justo en los cambios de sección`)
  const lens = S.map(s => s.t1 - s.t0), mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
  if (bpm === 128) ok(mean(S.filter(s => s.t0 > 31 && s.t0 < 38).map(s => s.t1 - s.t0)) <= mean(S.filter(s => s.t0 < 8).map(s => s.t1 - s.t0)) + 1e-9, `${style}: en el drop los planos son más cortos que en la intro`)
  ok(lens.every(x => x > 0.3 * per), `${tag}: ningún plano diminuto`)
}
// Todas las caras de una foto salen en primer plano si hay tiempo
{
  const plan = planMontage({ photos: [photos[0]], dur: 60, bpm: 128, offset: 0, fps: 30, style: 'dynamic' }), seen = new Set(plan.shots.filter(s => s.kind === 'face').map(s => s.focus[0]))
  ok(seen.size === 3, 'una foto de 3 personas: las 3 tienen su primer plano')
}
// Una sola foto sin caras no rompe
ok(planMontage({ photos: [photos[3]], dur: 8, bpm: 120, offset: 0, fps: 30, style: 'soft' }).shots.length >= 1, 'foto sin rostros: hay guion')
ok(planMontage({ photos: [photos[0]], dur: 1.5, bpm: 120, offset: 0, fps: 30, style: 'extreme' }).shots.length >= 1, 'clip cortísimo: hay guion')

// 3) Cámara
const OW = 576, OH = 1024
for (const [pi, ph] of photos.entries()) for (const kind of ['wide', 'face', 'pair', 'detail'] as const) {
  const focus = kind === 'pair' ? [0, Math.min(1, ph.faces.length - 1)] : kind === 'wide' ? [] : [0], c = restCam({ kind, focus }, ph, OW, OH), sc = coverScale(ph, OW, OH)
  ok(c.s > 0 && Number.isFinite(c.cx) && Number.isFinite(c.cy), `cámara ${pi}/${kind}: valores finitos`)
  const vw = OW / c.s, vh = OH / c.s
  ok(vw >= ph.W - 1e-6 || (c.cx - vw / 2 >= -1e-6 && c.cx + vw / 2 <= ph.W + 1e-6), `cámara ${pi}/${kind}: la ventana no se sale por los lados`)
  ok(vh >= ph.H - 1e-6 || (c.cy - vh / 2 >= -1e-6 && c.cy + vh / 2 <= ph.H + 1e-6), `cámara ${pi}/${kind}: la ventana no se sale por arriba/abajo`)
  if (kind === 'face' && ph.faces.length) ok(c.s >= sc * 1.15 - 1e-9, `cámara ${pi}: el primer plano acerca`)
}
const w0 = restCam({ kind: 'wide', focus: [] }, photos[0], OW, OH); ok(w0.s < coverScale(photos[0], OW, OH), 'foto apaisada a vertical: el plano general se aleja para que quepan todos (hay fondo desenfocado)')
const w1 = restCam({ kind: 'wide', focus: [] }, photos[1], OW, OH); near(w1.s, coverScale(photos[1], OW, OH), 1e-9, 'retrato a vertical: el plano general llena el cuadro')
{
  const plan = planMontage({ photos, dur: 20, bpm: 120, offset: 0, fps: 30, style: 'extreme' }), sh = plan.shots[2], ph = photos[sh.photo], rest = restCam(sh, ph, OW, OH)
  const a = cameraAt(sh, rest, ph, OW, OH, sh.t0 + 0.2, 0.5, 0), b = cameraAt(sh, rest, ph, OW, OH, sh.t0 + 0.2 + 1e-9, 0.5, 0)
  near(a.s, b.s, 1e-6, 'cámara continua en el tiempo'); ok(Math.abs(a.rot) < 0.2, 'ladeo pequeño'); ok(shotAt(plan.shots, sh.t0 + 0.01) === 2 && shotAt(plan.shots, plan.shots[3].t0) === 3, 'shotAt encuentra el plano')
  ok(clampCam({ cx: -500, cy: 9999, s: 1 }, ph, OW, OH).cx >= 0, 'clampCam acota')
}

// 4) Favoritas, transiciones permitidas, golpes de percusión y ediciones manuales
{
  const base = { photos, dur: 60, bpm: 128, offset: 0.1, bar0: 0, energy, fps: 30, style: 'dynamic' as Style }
  const cnt = (S: ReturnType<typeof planMontage>['shots']) => photos.map((_, i) => S.filter(s => s.photo === i).length)
  const a = cnt(planMontage(base).shots), b = cnt(planMontage({ ...base, weights: [1, 3, 1, 1] }).shots)
  ok(b[1] > a[1] && b[1] >= Math.max(b[0], b[2], b[3]), `foto favorita: sale más veces (${a[1]} → ${b[1]})`)
  ok(planMontage({ ...base, weights: [1, 3, 1, 1] }).shots.every((s, i, S) => i === 0 || s.photo !== S[i - 1].photo || s.finale), 'con favoritas nunca repite foto seguida')
  const only = planMontage({ ...base, trans: ['whip', 'cut'] }).shots; ok(only.every((s, i) => i === 0 || s.trans === 'whip' || s.trans === 'cut' || s.finale === true && false), 'solo usa las transiciones permitidas')
  ok(planMontage({ ...base, trans: ['spin'] }).shots.every((s, i) => i === 0 || s.trans === 'spin'), 'una sola transición permitida: todas iguales')
  // Golpes de percusión fuera de beat: en una ráfaga (drop) se corta en ellos
  const per = 60 / 128, hits = Array.from({ length: 40 }, (_, i) => ({ t: 30.1 + 0.37 + i * per * 0.75, k: 0.9 }))
  const plainPlan = planMontage({ ...base, style: 'extreme', cuts: [{ t: 30.1, drop: true }] }), plain = plainPlan.shots, withHitsPlan = planMontage({ ...base, style: 'extreme', cuts: [{ t: 30.1, drop: true }], hits }), withHits = { shots: withHitsPlan.shots, impacts: withHitsPlan.impacts }
  const off = withHits.shots.filter(s => { const j = (s.t0 - 0.1) / per; return Math.abs(j - Math.round(j)) > 1e-3 && s.t0 > 0 }).length
  ok(off > 0 && plain.filter(s => { const j = (s.t0 - 0.1) / per; return Math.abs(j - Math.round(j)) > 1e-3 && s.t0 > 0 }).length === 0, `cortes en percusión: ${off} fuera de beat (0 sin golpes)`)
  ok(withHits.shots.every((s, i, S) => s.t1 > s.t0 && (i === 0 || Math.abs(s.t0 - S[i - 1].t1) < 1e-9)), 'con golpes los planos siguen contiguos')
  ok(withHits.impacts.length > plainPlan.impacts.length, 'los cortes en percusión llevan un pequeño impacto')
  const soft = planMontage({ ...base, style: 'soft', hits }).shots; ok(soft.every(s => { const j = (s.t0 - 0.1) / per; return Math.abs(j - Math.round(j)) < 1e-3 || s.t0 === 0 || s.t0 === 60 }), 'el estilo elegante nunca corta fuera de beat')
  // Ediciones
  const ed = planMontage({ ...base, edits: { 2: { photo: 1, kind: 'face', focus: [0], trans: 'flash' }, 3: { photo: 3, kind: 'face', focus: [5] }, 4: { kind: 'pair', focus: [0, 1] } } }).shots, ref = planMontage(base).shots
  ok(ed[2].photo === 1 && ed[2].kind === 'face' && ed[2].trans === 'flash' && ed[2].tr > 0, 'edición: foto, plano y transición')
  ok(ed[3].photo === 3 && ed[3].kind === 'wide', 'edición no válida (foto sin caras) → plano general')
  ok(ed[4].kind === 'wide' || ph4ok(ed[4]), 'pareja solo si la foto tiene dos caras')
  ok(ed.length === ref.length && ed.every((s, i) => s.t0 === ref[i].t0 && s.t1 === ref[i].t1), 'las ediciones no cambian los tiempos')
  const ed0 = planMontage({ ...base, edits: { 0: { trans: 'flash' }, 999: { photo: 1 } } }).shots; ok(ed0[0].trans === 'cut' && ed0[0].tr === 0, 'el primer plano no admite transición; índices fuera de rango se ignoran')
}
function ph4ok(s: { photo: number; kind: string; focus: number[] }) { return s.kind === 'pair' && photos[s.photo].faces.length >= 2 }
console.log(fails ? `\n${fails} fallo(s)` : '\nTodo correcto'); process.exit(fails ? 1 : 0)
