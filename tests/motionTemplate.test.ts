/** Pruebas de MotionTemplate (módulo puro): npm test */
import { armDisp, armRot, dirAngle, makeJoints, pose as armPose, wrapPi } from '../src/ai/ArmSkin'
import { RIGID, buildTemplate, composeRenderer, estimatePeriod, fillGaps, fitRotation, makePlay, mul3, normalizePts, parseTemplate, serializeTemplate, syncRate, templateAt, toRendererAngles, type MotionTemplate, type RawFrame } from '../src/ai/MotionTemplate'
let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.error('✗', m) } else console.log('✓', m) }
const near = (a: number, b: number, tol: number, m: string) => ok(Math.abs(a - b) <= tol, `${m} (${a.toFixed(4)} ≈ ${b.toFixed(4)})`)
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
const YAW_RAD = 0.35, PITCH_RAD = 0.3
/** Copia de WarpRenderer.project() sin la perspectiva: lo que el renderer hace con un punto (dx, dy, z) respecto al pivote. */
const proj = ([dx, dy, z]: number[], ya: number, pa: number, r: number) => {
  const x1 = dx * Math.cos(ya) + z * Math.sin(ya), z1 = -dx * Math.sin(ya) + z * Math.cos(ya), y2 = dy * Math.cos(pa) + z1 * Math.sin(pa), z2 = -dy * Math.sin(pa) + z1 * Math.cos(pa)
  return [x1 * Math.cos(r) - y2 * Math.sin(r), x1 * Math.sin(r) + y2 * Math.cos(r), z2]
}
// Cara sintética: RIGID.length puntos (x derecha, y abajo, z negativo = hacia la cámara), en píxeles
const face0 = RIGID.map(() => [(rnd() - 0.5) * 140, (rnd() - 0.5) * 180, -rnd() * 60])

// 1) Ajuste + descomposición recuperan los ángulos del renderer
for (const [ya, pa, r] of [[0.2, 0, 0], [0, 0.15, 0], [0, 0, 0.3], [-0.25, 0.1, -0.2], [0.4, -0.2, 0.1]]) {
  const F = face0.flatMap(p => proj(p, ya, pa, r)), N = normalizePts(face0.flat()), Fn = normalizePts(F)
  const a = toRendererAngles(fitRotation(N.q, Fn.q))
  near(a.ya, ya, 1e-3, `ya ${ya}`); near(a.pa, pa, 1e-3, `pa ${pa}`); near(a.r, r, 1e-3, `r ${r}`)
}
const M = composeRenderer(0.3, -0.1, 0.2), A = toRendererAngles(M); near(A.ya, 0.3, 1e-9, 'compose/decompose ya'); near(A.pa, -0.1, 1e-9, 'pa'); near(A.r, 0.2, 1e-9, 'r')

// 2) De extremo a extremo: movimiento sintético con las fórmulas del renderer → plantilla → templateAt devuelve el mismo movimiento
const fps = 24, n = 96, sc = { fw: 100, W: 512, H: 512, headY: 200 }
const truth = (i: number) => { const t = i / fps; return { ya: 0.18 * Math.sin(2 * Math.PI * 0.5 * t), pa: 0.10 * Math.sin(2 * Math.PI * 0.5 * t + 1), r: 0.12 * Math.sin(2 * Math.PI * 0.25 * t) } }
const raw: RawFrame[] = Array.from({ length: n }, (_, i) => {
  const { ya, pa, r } = truth(i), pts = Float32Array.from(face0.flatMap(p => proj(p, ya, pa, r)).map((v, k) => v + (k % 3 === 0 ? 300 : k % 3 === 1 ? 200 : 0)))
  return { face: { pts, fw: 100, cx: 300, cy: 200, bs: { jawOpen: 0.3, eyeBlinkLeft: 0.9, eyeBlinkRight: 0, mouthSmileLeft: 0.6, mouthSmileRight: 0.6 } } }
})
const tpl = buildTemplate(raw, fps, 'test'), mid = (k: 'ya' | 'pa' | 'r') => { const v = Array.from({ length: n }, (_, i) => truth(i)[k]).sort((a, b) => a - b); return (v[n / 2 - 1] + v[n / 2]) / 2 }
const play = { tpl, gain: 1, mirror: false, rate: 1, start: 0, sc }
// Esperado: el mismo cálculo sobre la rotación exacta (R_t · R_0ᵀ · R_medianaᵀ), sin pasar por puntos ni ajuste
const Rt = (i: number) => composeRenderer(truth(i).ya, truth(i).pa, truth(i).r), R0T = [0, 1, 2].flatMap(r => [0, 1, 2].map(c => Rt(0)[3 * c + r]))
const rel = Array.from({ length: n }, (_, i) => mul3(Rt(i), R0T)), ra = rel.map(toRendererAngles)
const med = (v: number[]) => { const q = [...v].sort((a, b) => a - b); return (q[n / 2 - 1] + q[n / 2]) / 2 }
const RmT = (() => { const m = composeRenderer(med(ra.map(a => a.ya)), med(ra.map(a => a.pa)), med(ra.map(a => a.r))); return [0, 1, 2].flatMap(r => [0, 1, 2].map(c => m[3 * c + r])) })()
const want = rel.map(m => toRendererAngles(mul3(m, RmT)))
const fr = (i: number) => templateAt(i / fps, play).face
const maxErr = (get: (i: number) => number, w: (i: number) => number) => { let e = 0; for (let i = 4; i < n - 10; i++) e = Math.max(e, Math.abs(get(i) - w(i))); return e }
const eY = maxErr(i => fr(i).headYaw * YAW_RAD, i => want[i].ya), eP = maxErr(i => fr(i).headPitch * PITCH_RAD, i => want[i].pa), eR = maxErr(i => fr(i).headRoll, i => want[i].r)
ok(eY < 0.003, `yaw reproducido con error máx ${eY.toFixed(4)} rad`); ok(eP < 0.003, `pitch reproducido con error máx ${eP.toFixed(4)} rad`); ok(eR < 0.003, `roll reproducido con error máx ${eR.toFixed(4)} rad`)
// Sentido: la cabeza gira hacia donde giró en el vídeo (nariz a la derecha del todo ⇒ la del renderer también)
const noseDir = (i: number) => proj([0, 0, -50], fr(i).headYaw * YAW_RAD, 0, 0)[0]
let agree = 0, tot = 0; for (let i = 4; i < n - 10; i++) { if (Math.abs(truth(i).ya) > 0.05) { tot++; if (Math.sign(noseDir(i)) === Math.sign(proj([0, 0, -50], truth(i).ya, 0, 0)[0])) agree++ } } ok(tot > 10 && agree === tot, `la nariz va al mismo lado que en el vídeo (${agree}/${tot})`)
const f5 = templateAt(5 / fps, play).face
near(f5.eyeBlinkLeft, (0.9 - 0.1) / 0.7 > 1 ? 1 : (0.9 - 0.1) / 0.7, 0.05, 'parpadeo izquierdo del sujeto → eyeBlinkLeft'); near(f5.eyeBlinkRight, 0, 0.01, 'ojo derecho abierto')
near(f5.mouthOpen, 0.5, 0.02, 'jawOpen 0.3 → boca 0.5'); near(f5.mouthSmile, 1, 0.01, 'sonrisa')
const fm = templateAt(5 / fps, { ...play, mirror: true }).face
near(fm.eyeBlinkRight, f5.eyeBlinkLeft, 1e-6, 'espejo: el parpadeo cambia de ojo'); near(fm.headYaw, -f5.headYaw, 1e-6, 'espejo: yaw invertido'); near(fm.headRoll, -f5.headRoll, 1e-6, 'espejo: roll invertido')
// el sentido visible: yaw + (nariz a la derecha) ⇒ headYaw < 0 ⇒ en el renderer la nariz (z<0) va a la derecha
const nose = proj([0, 0, -50], -0.2, 0, 0); ok(nose[0] > 0, 'con ya<0 la nariz del renderer se desplaza a la derecha de la pantalla')

// 3) Cuerpo: bob y sway con signo correcto
const rawB: RawFrame[] = Array.from({ length: 96 }, (_, i) => { const t = i / 24, base = raw[i % n].face!; return { face: base, pose: { sx: 300 + 40 * Math.sin(2 * Math.PI * 1 * t), sy: 400 + 20 * Math.sin(2 * Math.PI * 2 * t), sw: 200, tilt: 0, hx: 300 + 30 * Math.sin(2 * Math.PI * 1 * t), hy: 700 } } })
const tb = buildTemplate(rawB, 24, 'body'); ok(tb.hasBody, 'detecta torso')
const pb = { tpl: tb, gain: 1, mirror: false, rate: 1, start: 0, sc }
const sw1 = templateAt(0.25, pb).body.swayX, sw2 = templateAt(0.75, pb).body.swayX   // caderas a la derecha a 0.25 s, a la izquierda a 0.75 s
ok(sw1 > 0.05 && sw2 < -0.05, `caderas a la derecha ⇒ swayX > 0 (${sw1.toFixed(2)} / ${sw2.toFixed(2)})`)
const lean = (t: number) => templateAt(t, pb).body.roll; ok(lean(0.25) > 0 && lean(0.75) < 0, 'hombros a la derecha de las caderas ⇒ roll del cuerpo > 0 (horario)')
ok(templateAt(0.25, { ...pb, mirror: true }).body.swayX < 0, 'espejo invierte el balanceo')
const sq = templateAt(0.125, pb).body.squash; ok(sq < 1, `bob + (abajo) ⇒ squash < 1 (${sq.toFixed(3)})`)
ok(templateAt(0.25, { ...pb, mirror: true }).body.roll < 0, 'espejo invierte el torso')

// 4) Periodicidad y sincronía con el ritmo
const mk = (f: (t: number) => number): MotionTemplate => { const t = { ...tpl, n: 144, dur: 6, ch: Object.fromEntries(Object.entries(tpl.ch).map(([k]) => [k, new Float32Array(144)])) as MotionTemplate['ch'] }; for (let i = 0; i < 144; i++) t.ch.bob[i] = f(i / 24); return t }
const pr = estimatePeriod(mk(t => 0.1 * Math.sin(2 * Math.PI * 2 * t - Math.PI / 2 + 0.9)))
ok(!!pr, 'hay periodo'); if (pr) { near(pr.period, 0.5, 0.03, 'periodo de un rebote a 2 Hz'); ok(pr.conf > 0.8, `fiabilidad alta (${pr.conf.toFixed(2)})`); ok(pr.phase >= 0 && pr.phase < 0.5, 'golpe dentro del primer ciclo') }
ok(estimatePeriod(mk(() => 0)) === null, 'sin movimiento ⇒ sin periodo')
near(syncRate(1.0, 120), 1, 1e-9, 'ciclo de 1 s a 120 BPM ⇒ 2 beats, velocidad 1'); near(syncRate(1.0, 100), 1 / 1.2, 1e-9, 'a 100 BPM ⇒ 0.833×'); ok(syncRate(0.1, 120) >= 0.5 && syncRate(9, 60) <= 2, 'velocidad acotada')
const spec = { bpm: 120, offset: 0.1, fps: 24, energy: [] }, bt = makePlay({ ...mk(t => 0.1 * Math.sin(2 * Math.PI * 2 * t)), period: 0.5, periodConf: 0.9, phase: 0.125 }, { mode: 'beat', gain: 1, mirror: false, sc, spec })
near(bt.rate, 1, 1e-9, 'beat: rebote de 0.5 s a 120 BPM ⇒ velocidad 1'); near(bt.start + spec.offset * bt.rate, 0.125, 1e-9, 'beat: el golpe de la plantilla cae en el primer beat')
near(makePlay(tpl, { mode: 'video', gain: 1, mirror: false, sc, startAt: 7.5 }).start, 7.5, 1e-9, 'video: mismo tiempo, empieza en startAt')

// 5) Guardar/cargar y huecos
const rt = parseTemplate(serializeTemplate(tb)); ok(rt.n === tb.n && rt.hasBody === tb.hasBody && Math.abs(rt.ch.sway[10] - tb.ch.sway[10]) < 1e-3, 'ida y vuelta JSON')
let bad = false; try { parseTemplate('{"x":1}') } catch { bad = true } ok(bad, 'rechaza archivos que no son plantillas')
const g = fillGaps([undefined, 1, undefined, undefined, 4, undefined]); ok(g[0] === 1 && g[2] === 2 && g[3] === 3 && g[5] === 4, 'fillGaps interpola y repite extremos')
let none = false; try { buildTemplate(Array.from({ length: 30 }, () => ({})), 24, 'x') } catch { none = true } ok(none, 'sin rostro ⇒ error claro')

// 6) Brazos y manos
{
  // Foto: persona de frente, brazo izquierdo de la pantalla colgando (hombro (200,300) → codo (190,420) → muñeca (185,530), mano hacia abajo)
  const J = makeJoints({ x: 200, y: 300 }, { x: 190, y: 420 }, { x: 185, y: 530 }, { x: 183, y: 560 })!
  ok(!!J && Math.abs(J.u) < 0.2 && J.u < 0 && J.f < 0, `reposo: el brazo cuelga ligeramente hacia la izquierda de la pantalla (u=${J.u.toFixed(3)})`)
  ok(makeJoints({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }) === null, 'huesos diminutos ⇒ sin brazo')
  // Objetivo = el propio reposo ⇒ ningún giro ni desplazamiento
  const R0 = armRot(J, { u: J.u, f: J.f, hd: J.hd }, 1)
  ok(Math.abs(R0.a1) + Math.abs(R0.a2) + Math.abs(R0.a3) < 1e-9, 'objetivo = reposo ⇒ giros 0')
  const d0 = armDisp(188, 480, J, R0); ok(Math.hypot(d0[0], d0[1]) < 1e-9, 'sin giro ⇒ sin desplazamiento')
  // Levantar el brazo hacia la derecha de la pantalla (u = +π/2: horizontal hacia la derecha), antebrazo igual
  const T = { u: Math.PI / 2, f: Math.PI / 2, hd: J.hd }, R1 = armRot(J, T, 1), P1 = armPose(J, R1)
  near(dirAngle(J.s, P1.e), T.u, 1e-9, 'tras el giro el brazo apunta al ángulo objetivo (derecha)'); near(dirAngle(P1.e, P1.w), T.f, 1e-9, 'el antebrazo también')
  near(Math.hypot(P1.e.x - J.s.x, P1.e.y - J.s.y), Math.hypot(J.e.x - J.s.x, J.e.y - J.s.y), 1e-9, 'la longitud del brazo se conserva')
  ok(P1.e.x > J.s.x + 100, 'subir con u=+π/2 manda el codo a la DERECHA de la pantalla')
  // Un punto sobre el centro del antebrazo (peso máximo) debe seguir al hueso; la muñeca va a la muñeca nueva
  const wd = armDisp(J.w.x, J.w.y, J, R1), wNew = { x: J.w.x + wd[0], y: J.w.y + wd[1] }
  ok(Math.hypot(wNew.x - P1.w.x, wNew.y - P1.w.y) < 0.25 * J.R, `la muñeca de la malla llega a la muñeca nueva (error ${Math.hypot(wNew.x - P1.w.x, wNew.y - P1.w.y).toFixed(1)} px, radio ${J.R.toFixed(0)})`)
  // Lejos del brazo no se mueve nada (cara, fondo)
  const far = armDisp(400, 100, J, R1); ok(Math.hypot(far[0], far[1]) < 1e-6, 'lejos del brazo no se desplaza')
  // El torso, al lado del hombro y por dentro, casi no se mueve (la rampa en el hombro)
  const torso = armDisp(260, 330, J, R1); ok(Math.hypot(torso[0], torso[1]) < 1.5, `el pecho junto al hombro casi no se arrastra (${Math.hypot(torso[0], torso[1]).toFixed(2)} px)`)
  // Límites y simetría de envoltura
  ok(Math.abs(armRot(J, { u: J.u + 3, f: J.f + 3, hd: 3 }, 1).a1) <= 2.0 + 1e-9, 'giro del brazo acotado'); near(Math.abs(wrapPi(3 * Math.PI)), Math.PI, 1e-9, 'wrapPi envuelve a ±π'); near(wrapPi(0.2 + 4 * Math.PI), 0.2, 1e-9, 'wrapPi conserva lo que ya está en rango')
  ok(Math.abs(armRot(J, T, 0).a1) < 1e-12, 'ganancia 0 ⇒ el brazo se queda como en la foto')
}
{
  // Plantilla con brazo izquierdo de la pantalla subiendo y bajando (u: 0 → π/2) y derecho quieto; vídeo de frente
  const nA = 96, fpsA = 24, rawA: RawFrame[] = Array.from({ length: nA }, (_, i) => {
    const t = i / fpsA, up = (1 - Math.cos(2 * Math.PI * 0.5 * t)) / 2 * (Math.PI / 2)
    return { face: raw[i % n].face, pose: { sx: 300, sy: 400, sw: 200, tilt: 0, arms: { l: { u: -up, f: -up, hd: 0.1 }, r: { u: 0.1, f: 0.1 } } } } as RawFrame
  })
  const ta = buildTemplate(rawA, fpsA, 'arms'); ok(!!ta.armL && !!ta.armR, 'detecta los dos brazos')
  const J = makeJoints({ x: 200, y: 300 }, { x: 200, y: 420 }, { x: 200, y: 530 }, { x: 200, y: 560 })!, JR = makeJoints({ x: 320, y: 300 }, { x: 320, y: 420 }, { x: 320, y: 530 })!
  const pa = { tpl: ta, gain: 1, mirror: false, rate: 1, start: 0, sc, rig: { l: J, r: JR } }
  const b0 = templateAt(0, pa).body.arms!, bm = templateAt(1.0, pa).body.arms!   // a 1.0 s el brazo está arriba del todo (-π/2: hacia la izquierda)
  ok(Math.abs(b0.l!.a1) < 0.05, 'al inicio el brazo izquierdo está abajo ⇒ giro ≈ 0'); ok(Math.abs(bm.l!.a1 - Math.PI / 2) < 0.1, `arriba del todo ⇒ giro del brazo ≈ +π/2 (${bm.l!.a1.toFixed(2)})`)
  const Pm = armPose(J, bm.l!); ok(Pm.e.x < J.s.x - 100, 'el brazo izquierdo de la pantalla sube hacia la izquierda de la pantalla como en el vídeo')
  // Espejo: el brazo que se mueve en el vídeo (izq.) pasa a mover el derecho de la foto, hacia la derecha
  const bmm = templateAt(1.0, { ...pa, mirror: true }).body.arms!; ok(bmm.r!.a1 < -1.2 && Math.abs(bmm.l!.a1) < 0.2, 'espejo: lo que hacía el brazo izquierdo lo hace el derecho')
  ok(armPose(JR, bmm.r!).e.x > JR.s.x + 100, 'espejo: el brazo derecho sube hacia la derecha')
  // Sin rig o sin brazos en la plantilla ⇒ no hay brazos
  ok(templateAt(1.0, { ...pa, rig: null }).body.arms === undefined, 'sin esqueleto de la foto ⇒ sin brazos')
  ok(templateAt(1.0, { ...pa, tpl: { ...ta, armL: false } }).body.arms?.l === undefined, 'brazo no visto en el vídeo ⇒ no se mueve')
  // Ida y vuelta + plantilla antigua (sin canales de brazos)
  const rt2 = parseTemplate(serializeTemplate(ta)); ok(rt2.armL === true && Math.abs(rt2.ch.uL[30] - ta.ch.uL[30]) < 1e-3, 'ida y vuelta con brazos')
  const old = JSON.parse(serializeTemplate(tb)); for (const k of ['uL', 'fL', 'hL', 'uR', 'fR', 'hR']) delete old.ch[k]; delete old.armL; delete old.armR
  const ro = parseTemplate(JSON.stringify(old)); ok(!ro.armL && ro.ch.uL.length === ro.n, 'abre plantillas antiguas sin brazos')
  // Cruce de ±π: brazo en alto oscilando alrededor de "recto arriba" no debe dar saltos
  const rawW: RawFrame[] = Array.from({ length: 96 }, (_, i) => { const a = Math.PI - 0.3 * Math.sin(2 * Math.PI * (i / 24)), w = Math.atan2(Math.sin(a), Math.cos(a)); return { face: raw[i % n].face, pose: { sx: 300, sy: 400, sw: 200, tilt: 0, arms: { l: { u: w, f: w } } } } as RawFrame })
  const tw = buildTemplate(rawW, 24, 'wrap'); let maxJump = 0; for (let i = 1; i < tw.n; i++) maxJump = Math.max(maxJump, Math.abs(tw.ch.uL[i] - tw.ch.uL[i - 1])); ok(maxJump < 0.2, `sin saltos de 2π al cruzar ±π (salto máx ${maxJump.toFixed(3)})`)
}
console.log(fails ? `\n${fails} fallo(s)` : '\nTodo correcto'); process.exit(fails ? 1 : 0)
